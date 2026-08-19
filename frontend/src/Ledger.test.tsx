// The Ledger tab. Two things are being protected here, and neither is cosmetic:
//
//  · "Mark as paid" RECORDS a payment the merchant already made — it must never read as if
//    the poppy sent money, and it must not accept an amount that disagrees with what is owed.
//  · The export hands the file to the SYSTEM BROWSER, because neither half of a poppy may save
//    it: the frontend is sandboxed (a download link silently does nothing — the family's most
//    expensive UI bug) and the backend is confined to its own folder by design.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { host } from "./host";
import { Ledger } from "./Ledger";
import type { Affiliate } from "./types";

const oliver: Affiliate = {
  affId: "aff-oliver",
  email: "oliver@example.com",
  displayName: "Oliver",
  status: "active",
  code: "OLIVER7K3M",
  promotionCodeId: "promo_1",
  createdDay: "2026-08-01",
  placements: [],
  totals: [{ currency: "eur", earnedCents: 5000, refundedCents: 500, paidCents: 1000, owedCents: 3500 }],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "payouts").mockResolvedValue({ payouts: [] });
});

const open = async () => {
  render(<Ledger affiliates={[oliver]} loading={false} ready onChanged={vi.fn().mockResolvedValue(undefined)} />);
  await userEvent.click(await screen.findByRole("button", { name: /mark as paid/i }));
  return screen.getByText(/record a payment to oliver/i).closest(".modal") as HTMLElement;
};

describe("before Setup has run", () => {
  it("asks for nothing from a table that doesn't exist yet, and says so plainly", () => {
    // First dev-install, 2026-08-14: the tab queried payouts on mount, DynamoDB answered
    // "Requested resource not found", and the merchant saw a raw 500 before they had pressed
    // a single button. Not an error they caused → never an error they should read.
    const payouts = vi.spyOn(api, "payouts");
    render(<Ledger affiliates={[]} loading={false} ready={false} onChanged={vi.fn()} />);
    expect(screen.getByText(/finish the setup tab first/i)).toBeInTheDocument();
    expect(payouts).not.toHaveBeenCalled();
    expect(screen.queryByText(/resource not found/i)).not.toBeInTheDocument();
  });
});

describe("what the merchant sees they owe", () => {
  it("shows owed, not just earned — the number they actually plan around", async () => {
    render(<Ledger affiliates={[oliver]} loading={false} ready onChanged={vi.fn()} />);
    // Owed appears both as the programme-wide total and on Oliver's own row: €50 earned,
    // less €5 refunded, less €10 already paid.
    expect(await screen.findAllByText("€35.00")).toHaveLength(2);
    expect(screen.getByText(/already paid €10\.00/i)).toBeInTheDocument();
  });

  it("says plainly when there is nothing to pay, instead of showing an empty table", async () => {
    render(<Ledger affiliates={[]} loading={false} ready onChanged={vi.fn()} />);
    expect(await screen.findByText(/nobody is waiting to be paid/i)).toBeInTheDocument();
  });
});

describe("recording a payment", () => {
  it("says WE never move money — it records what the merchant already sent", async () => {
    const modal = await open();
    expect(modal).toHaveTextContent(/you have already paid them/i);
    expect(modal).toHaveTextContent(/never moves money/i);
  });

  it("pre-fills the exact amount owed", async () => {
    const modal = await open();
    expect(within(modal).getByDisplayValue("35.00")).toBeInTheDocument();
  });

  it("refuses an amount that doesn't match what's owed", async () => {
    // A ledger that disagrees with the merchant's bank is worse than no ledger: it is a
    // number two people will argue about later.
    const markPaid = vi.spyOn(api, "markPaid");
    const modal = await open();
    const amount = within(modal).getByDisplayValue("35.00");
    await userEvent.clear(amount);
    await userEvent.type(amount, "20.00");

    expect(within(modal).getByRole("button", { name: /i've paid this/i })).toBeDisabled();
    expect(markPaid).not.toHaveBeenCalled();
  });

  it("sends the owed amount in minor units, with a reference that makes a retry safe", async () => {
    const markPaid = vi.spyOn(api, "markPaid").mockResolvedValue({ recorded: true });
    const modal = await open();
    await userEvent.type(within(modal).getByLabelText(/note/i), "bank transfer 8842");
    await userEvent.click(within(modal).getByRole("button", { name: /i've paid this/i }));

    expect(markPaid).toHaveBeenCalledTimes(1);
    const sent = markPaid.mock.calls[0]![0];
    expect(sent).toMatchObject({ affId: "aff-oliver", currency: "eur", amountCents: 3500, note: "bank transfer 8842" });
    // The reference is generated once per dialog — a double-click records ONE payment.
    expect(sent.batchId).toMatch(/^pay-/);
  });

  it("keeps the merchant in the dialog and shows why, when the backend refuses", async () => {
    vi.spyOn(api, "markPaid").mockRejectedValue(new Error("That amount doesn't match what's owed right now."));
    const modal = await open();
    await userEvent.click(within(modal).getByRole("button", { name: /i've paid this/i }));
    expect(await screen.findByText(/doesn't match what's owed/i)).toBeInTheDocument();
  });
});

describe("the export", () => {
  it("hands the files to the system browser — nobody in a poppy may write to the user's disk", async () => {
    // The frontend is a sandboxed frame (no downloads); the backend is confined to its own
    // folder (no Documents). So the backend mints one-shot tokens and the SYSTEM browser
    // collects the bytes through the host's passthrough on this frontend's own origin.
    window.history.pushState({}, "", "/ext-ui/com.affiliatepoppy.desktop/index.html");
    vi.spyOn(api, "exportCsv").mockResolvedValue({
      rows: 42,
      files: [
        { token: "tok-1", filename: "AffiliatePoppy-commissions-2026-08-14.csv" },
        { token: "tok-2", filename: "AffiliatePoppy-placements-2026-08-14.csv" },
      ],
    });
    const open = vi.spyOn(host, "openExternal").mockResolvedValue(undefined);
    render(<Ledger affiliates={[oliver]} loading={false} ready onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /export everything/i }));

    expect(await screen.findByText(/AffiliatePoppy-commissions-2026-08-14\.csv/)).toBeInTheDocument();
    expect(screen.getByText(/AffiliatePoppy-placements-2026-08-14\.csv/)).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(open.mock.calls.map((c) => c[0])).toEqual([
      "http://localhost:3000/ext-dl/com.affiliatepoppy.desktop/local-download/tok-1",
      "http://localhost:3000/ext-dl/com.affiliatepoppy.desktop/local-download/tok-2",
    ]);
    // And it says so — the merchant should know their disk was never touched.
    expect(screen.getByText(/never writes to your disk/i)).toBeInTheDocument();
  });

  it("shows the failure rather than looking like nothing happened", async () => {
    vi.spyOn(api, "exportCsv").mockRejectedValue(new Error("Couldn't build the file."));
    render(<Ledger affiliates={[oliver]} loading={false} ready onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /export everything/i }));
    expect(await screen.findByText(/couldn't build the file/i)).toBeInTheDocument();
  });
});

describe("what developers owe back (P7)", () => {
  it("shows each developer's advanced commission — and nothing at all when there are none", async () => {
    vi.spyOn(api, "partners").mockResolvedValue({
      partners: [],
      totals: [{ account: "acct_1AbCdEfGhIjK", label: "Olly's Tools", currency: "eur", advancedCents: 950 }],
    });
    render(<Ledger affiliates={[oliver]} loading={false} ready onChanged={vi.fn()} />);
    expect(await screen.findByText(/owed to you by developers/i)).toBeInTheDocument();
    expect(screen.getByText("Olly's Tools")).toBeInTheDocument();
    expect(screen.getByText("€9.50")).toBeInTheDocument();
    // Reported, never collected — the sentence that keeps D12 honest.
    expect(screen.getByText(/collecting it is between you and them/i)).toBeInTheDocument();
  });

  it("stays invisible for a merchant with no developers", async () => {
    vi.spyOn(api, "partners").mockResolvedValue({ partners: [], totals: [] });
    render(<Ledger affiliates={[oliver]} loading={false} ready onChanged={vi.fn()} />);
    await screen.findByText(/who you owe/i);
    expect(screen.queryByText(/owed to you by developers/i)).not.toBeInTheDocument();
  });
});

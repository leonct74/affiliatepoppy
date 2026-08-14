// The Ledger tab. Two things are being protected here, and neither is cosmetic:
//
//  · "Mark as paid" RECORDS a payment the merchant already made — it must never read as if
//    the poppy sent money, and it must not accept an amount that disagrees with what is owed.
//  · The export writes a FILE and tells the merchant where it is, because a poppy frontend is
//    sandboxed: a download link would silently do nothing (the family's most expensive UI bug).

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
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
  totals: [{ currency: "eur", earnedCents: 5000, refundedCents: 500, paidCents: 1000, owedCents: 3500 }],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "payouts").mockResolvedValue({ payouts: [] });
});

const open = async () => {
  render(<Ledger affiliates={[oliver]} loading={false} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  await userEvent.click(await screen.findByRole("button", { name: /mark as paid/i }));
  return screen.getByText(/record a payment to oliver/i).closest(".modal") as HTMLElement;
};

describe("what the merchant sees they owe", () => {
  it("shows owed, not just earned — the number they actually plan around", async () => {
    render(<Ledger affiliates={[oliver]} loading={false} onChanged={vi.fn()} />);
    // Owed appears both as the programme-wide total and on Oliver's own row: €50 earned,
    // less €5 refunded, less €10 already paid.
    expect(await screen.findAllByText("€35.00")).toHaveLength(2);
    expect(screen.getByText(/already paid €10\.00/i)).toBeInTheDocument();
  });

  it("says plainly when there is nothing to pay, instead of showing an empty table", async () => {
    render(<Ledger affiliates={[]} loading={false} onChanged={vi.fn()} />);
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
  it("names the file the BACKEND wrote — a sandboxed frontend cannot download", async () => {
    vi.spyOn(api, "exportCsv").mockResolvedValue({
      path: "/Users/x/Documents/AffiliatePoppy-commissions-2026-08-14.csv",
      rows: 42,
    });
    render(<Ledger affiliates={[oliver]} loading={false} onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /export everything/i }));

    expect(await screen.findByText(/AffiliatePoppy-commissions-2026-08-14\.csv/)).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("shows the failure rather than looking like nothing happened", async () => {
    vi.spyOn(api, "exportCsv").mockRejectedValue(new Error("Couldn't write the file."));
    render(<Ledger affiliates={[oliver]} loading={false} onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /export everything/i }));
    expect(await screen.findByText(/couldn't write the file/i)).toBeInTheDocument();
  });
});

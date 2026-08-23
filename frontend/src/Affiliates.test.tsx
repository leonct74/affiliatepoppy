// The Affiliates tab — approving someone, and retiring their code.
//
// Retiring is destructive in a way that is easy to underestimate: it is somebody's income
// stream. So it takes the family's type-to-confirm ceremony AND says, in the dialog, that
// what they have already earned is untouched — because that is the question a merchant is
// actually asking themselves at that moment.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Affiliates } from "./Affiliates";
import { api } from "./api";
import { host } from "./host";
import type { Affiliate, ProgramConfig } from "./types";

const affiliate = (over: Partial<Affiliate> = {}): Affiliate => ({
  affId: "aff-oliver",
  email: "oliver@example.com",
  displayName: "Oliver",
  status: "active",
  code: "OLIVER7K3M",
  promotionCodeId: "promo_1",
  createdDay: "2026-08-01",
  placements: [],
  totals: [{ currency: "eur", earnedCents: 5000, refundedCents: 0, paidCents: 0, owedCents: 5000 }],
  ...over,
});

const config = {
  settings: { discountPct: 5, commissionPct: 10, firstPaymentOnly: false, autoApprove: false, maxAffiliates: 1000, notifyEmail: "" },
} as ProgramConfig;

beforeEach(() => vi.restoreAllMocks());

const show = (list: Affiliate[]) =>
  render(<Affiliates affiliates={list} config={config} loading={false} onChanged={vi.fn().mockResolvedValue(undefined)} />);

describe("people waiting to be approved", () => {
  it("are shown separately, with what approving actually does", async () => {
    show([affiliate({ status: "pending", code: "", affId: "aff-new", displayName: "Maria" })]);
    expect(screen.getByText(/waiting for you/i)).toBeInTheDocument();
    expect(screen.getByText(/creates their code in stripe/i)).toBeInTheDocument();
  });

  it("get their code when approved", async () => {
    const approve = vi.spyOn(api, "approve").mockResolvedValue({ affiliate: affiliate() });
    show([affiliate({ status: "pending", code: "" })]);
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    // No preferred code from this button: the merchant approving in one click gets the
    // generated one. (Choosing a code by hand is the API's `code` argument, not this path.)
    expect(approve).toHaveBeenCalledWith("aff-oliver");
  });

  it("surfaces a Stripe failure instead of leaving the button looking broken", async () => {
    vi.spyOn(api, "approve").mockRejectedValue(new Error("Connect your Stripe account first."));
    show([affiliate({ status: "pending", code: "" })]);
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(await screen.findByText(/connect your stripe account first/i)).toBeInTheDocument();
  });
});

describe("retiring a code", () => {
  const openDialog = async () => {
    show([affiliate()]);
    await userEvent.click(screen.getByRole("button", { name: /retire code/i }));
    return screen.getByText(/retire oliver's code\?/i).closest(".modal") as HTMLElement;
  };

  it("never happens on a single click", async () => {
    const retire = vi.spyOn(api, "retire");
    await openDialog();
    expect(retire).not.toHaveBeenCalled();
  });

  it("names the code, and promises their earnings are kept", async () => {
    const modal = await openDialog();
    expect(modal).toHaveTextContent("OLIVER7K3M");
    expect(modal).toHaveTextContent(/stop working at your checkout/i);
    expect(modal).toHaveTextContent(/everything they've already earned stays/i);
  });

  it("stays disarmed until the code is typed", async () => {
    const modal = await openDialog();
    const confirm = within(modal).getByRole("button", { name: /retire this code/i });
    expect(confirm).toBeDisabled();

    await userEvent.type(within(modal).getByRole("textbox"), "OLIVER");
    expect(confirm).toBeDisabled();

    await userEvent.type(within(modal).getByRole("textbox"), "7K3M");
    expect(confirm).toBeEnabled();
  });

  it("retires once the code matches", async () => {
    const retire = vi.spyOn(api, "retire").mockResolvedValue({ affiliate: affiliate({ status: "retired" }) });
    const modal = await openDialog();
    await userEvent.type(within(modal).getByRole("textbox"), "oliver7k3m"); // case-insensitive
    await userEvent.click(within(modal).getByRole("button", { name: /retire this code/i }));
    expect(retire).toHaveBeenCalledWith("aff-oliver");
  });
});

describe("one affiliate's own rate (D9)", () => {
  it("shows the programme rate when they have no override of their own", () => {
    show([affiliate()]);
    expect(screen.getByText(/commission: 10%/i)).toBeInTheDocument();
  });

  it("marks an override as theirs alone, so it isn't mistaken for the programme's", () => {
    show([affiliate({ pctOverride: 25 })]);
    expect(screen.getByText(/commission: 25% \(just for them\)/i)).toBeInTheDocument();
  });

  it("saves a new rate, and can hand them back to the programme rate", async () => {
    const setRate = vi.spyOn(api, "setRate").mockResolvedValue({ affiliate: affiliate() });
    show([affiliate({ pctOverride: 25 })]);
    await userEvent.click(screen.getByRole("button", { name: /change/i }));

    const box = screen.getByDisplayValue("25");
    await userEvent.clear(box);
    await userEvent.type(box, "30");
    await userEvent.click(screen.getByRole("button", { name: /save rate/i }));
    expect(setRate).toHaveBeenCalledWith("aff-oliver", 30);

    await userEvent.click(screen.getByRole("button", { name: /change/i }));
    await userEvent.click(screen.getByRole("button", { name: /use the programme rate/i }));
    expect(setRate).toHaveBeenLastCalledWith("aff-oliver", null);
  });
});

describe("where they share their code", () => {
  it("shows the links an affiliate declared, opened in the system browser", async () => {
    // A poppy frame can't open a window itself; the host bridge does it.
    const open = vi.spyOn(host, "openExternal").mockResolvedValue(undefined);
    show([
      affiliate({
        placements: [
          { url: "https://www.youtube.com/watch?v=abc", note: "My review" },
          { url: "https://instagram.com/p/xyz", note: "" },
        ],
      }),
    ]);
    expect(screen.getByText(/where they share it/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /my review/i }));
    expect(open).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc");
    // No note → the host name stands in, so the merchant still knows where it goes.
    expect(screen.getByRole("button", { name: /instagram\.com/i })).toBeInTheDocument();
  });

  it("says nothing at all when they declared nothing — it was optional", () => {
    show([affiliate({ placements: [] })]);
    expect(screen.queryByText(/where they share it/i)).not.toBeInTheDocument();
  });
});

describe("an empty programme", () => {
  it("points at the one thing that fixes it", () => {
    show([]);
    expect(screen.getByText(/share the link from the setup tab/i)).toBeInTheDocument();
  });
});

describe("the sign-up link on the list (the link is the product)", () => {
  it("sits at the top with a copy button whenever it exists", () => {
    render(
      <Affiliates
        affiliates={[affiliate()]}
        config={null}
        loading={false}
        portalUrl="https://portal.lambda-url.eu-west-1.on.aws/"
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText("https://portal.lambda-url.eu-west-1.on.aws/")).toBeInTheDocument();
    expect(screen.getByText(/share it anywhere/i)).toBeInTheDocument();
  });
});

describe("turning an application down", () => {
  it("asks first, then declines — and says plainly that nothing is destroyed", async () => {
    const decline = vi.spyOn(api, "decline").mockResolvedValue({ affiliate: affiliate({ status: "declined" }) });
    show([affiliate({ status: "pending", code: "", displayName: "Maria" })]);
    await userEvent.click(screen.getByRole("button", { name: /^decline$/i }));
    expect(screen.getByText(/decline maria\?/i)).toBeInTheDocument();
    expect(screen.getByText(/still approve them/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /decline the application/i }));
    expect(decline).toHaveBeenCalledWith("aff-oliver");
  });

  it("moves them out of the queue and behind their own toggle — they are not partners", () => {
    show([affiliate({ status: "declined", code: "", displayName: "Maria" })]);
    expect(screen.queryByText(/waiting for you/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Maria")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /declined \(1\)/i })).toBeInTheDocument();
  });
});

describe("finding one person among many (founder, 2026-08-23)", () => {
  it("offers the search from the first affiliate — not once the list is already unusable", () => {
    show([affiliate()]);
    expect(screen.getByRole("searchbox", { name: /find an affiliate/i })).toBeInTheDocument();
  });

  it("finds anyone by name, email, code or what they said at sign-up — including the declined", async () => {
    show([
      affiliate({ affId: "a1", displayName: "Oliver" }),
      affiliate({ affId: "a2", displayName: "Maria", email: "maria@example.com", code: "MARIA22", status: "declined" }),
      affiliate({ affId: "a3", displayName: "Sam", email: "sam@example.com", code: "SAM99", channels: "YouTube" }),
    ]);
    const box = screen.getByRole("searchbox", { name: /find an affiliate/i });

    await userEvent.type(box, "maria");
    expect(screen.getByText(/1 of 3 match/i)).toBeInTheDocument();
    expect(screen.getByText("Maria")).toBeInTheDocument(); // declined, and still findable
    expect(screen.queryByText("Oliver")).not.toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, "youtube");
    expect(screen.getByText("Sam")).toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, "zzz");
    expect(screen.getByText(/nobody matches "zzz"/i)).toBeInTheDocument();
  });
});

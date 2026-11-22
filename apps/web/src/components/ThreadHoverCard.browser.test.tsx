import { describe, expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { ThreadHoverCard } from "./ThreadHoverCard";

import "~/index.css";

describe("ThreadHoverCard", () => {
  it("wraps long titles onto multiple lines instead of truncating to one line", async () => {
    const shortTitle = "Fix sidebar";
    const longTitle =
      "Investigate intermittent session refresh flicker when switching environments on slow networks";
    const veryLongTitle = Array.from({ length: 8 }, () => longTitle).join(" ");

    await using screen = await render(
      <div>
        <ThreadHoverCard title={shortTitle}>Details</ThreadHoverCard>
        <ThreadHoverCard title={longTitle}>Details</ThreadHoverCard>
        <ThreadHoverCard title={veryLongTitle}>Details</ThreadHoverCard>
      </div>,
    );

    const shortEl = screen.getByText(shortTitle, { exact: true }).element() as HTMLElement;
    const longEl = screen.getByText(longTitle, { exact: true }).element() as HTMLElement;
    const veryLongEl = screen.getByText(veryLongTitle, { exact: true }).element() as HTMLElement;

    const shortHeight = shortEl.getBoundingClientRect().height;
    const longHeight = longEl.getBoundingClientRect().height;
    const veryLongHeight = veryLongEl.getBoundingClientRect().height;

    expect(shortHeight).toBeGreaterThan(0);
    expect(longHeight).toBeGreaterThan(shortHeight * 1.5);
    expect(longEl.scrollWidth).toBeLessThanOrEqual(longEl.clientWidth + 1);
    expect(veryLongHeight).toBeLessThanOrEqual(Math.ceil(shortHeight * 3) + 2);
  });

  it("wraps long unbroken identifiers inside the card width", async () => {
    const shortTitle = "Fix";
    const unbrokenTitle =
      "feature/really_long_unbroken_branch_name_without_any_spaces_for_hover_card_wrapping_check";

    await using screen = await render(
      <div>
        <ThreadHoverCard title={shortTitle}>Details</ThreadHoverCard>
        <ThreadHoverCard title={unbrokenTitle}>Details</ThreadHoverCard>
      </div>,
    );

    const shortEl = screen.getByText(shortTitle, { exact: true }).element() as HTMLElement;
    const unbrokenEl = screen.getByText(unbrokenTitle, { exact: true }).element() as HTMLElement;

    expect(unbrokenEl.getBoundingClientRect().height).toBeGreaterThan(
      shortEl.getBoundingClientRect().height * 1.5,
    );
    expect(unbrokenEl.scrollWidth).toBeLessThanOrEqual(unbrokenEl.clientWidth + 1);
  });
});

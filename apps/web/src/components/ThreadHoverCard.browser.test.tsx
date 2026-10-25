import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";

const settingsOverrides = vi.hoisted(() => ({ hoverPreviews: true }));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import { ThreadHoverCard, ThreadHoverCardPopup } from "./ThreadHoverCard";
import { Tooltip, TooltipTrigger } from "./ui/tooltip";

function setup({ hoverPreviews }: { hoverPreviews: boolean }) {
  settingsOverrides.hoverPreviews = hoverPreviews;
}

function openCard() {
  return render(
    <Tooltip open>
      <TooltipTrigger render={<button type="button">Thread</button>} />
      <ThreadHoverCardPopup>
        <ThreadHoverCard title="Card title">details</ThreadHoverCard>
      </ThreadHoverCardPopup>
    </Tooltip>,
  );
}

describe("ThreadHoverCardPopup", () => {
  it("renders the card when hover previews are on", async () => {
    setup({ hoverPreviews: true });
    await using _ = await openCard();

    await expect.element(page.getByText("Card title")).toBeVisible();
  });

  it("renders nothing when hover previews are off", async () => {
    setup({ hoverPreviews: false });
    await using _ = await openCard();

    await expect.element(page.getByRole("button", { name: "Thread" })).toBeVisible();
    await expect.element(page.getByText("Card title")).not.toBeInTheDocument();
  });
});

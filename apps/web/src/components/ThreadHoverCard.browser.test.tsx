import { describe, expect, it, vi } from "vite-plus/test";

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
    settingsOverrides.hoverPreviews = true;
    await using _ = await openCard();
    await expect.poll(() => document.body.textContent).toContain("Card title");
  });

  it("renders nothing when hover previews are off", async () => {
    settingsOverrides.hoverPreviews = false;
    await using _ = await openCard();
    expect(document.body.textContent).toContain("Thread");
    expect(document.body.textContent).not.toContain("Card title");
  });
});

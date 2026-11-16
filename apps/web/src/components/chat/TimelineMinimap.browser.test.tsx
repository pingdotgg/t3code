import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import "../../index.css";

const settingsOverrides = vi.hoisted(() => ({ hoverPreviews: true }));
vi.mock(import("../../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import { TimelineMinimap } from "./TimelineMinimap";
import type { TimelineMinimapItem } from "./timelineMinimapItems";

const items: ReadonlyArray<TimelineMinimapItem> = [
  { id: "a", rowIndex: 0, userText: "First question", assistantText: "First answer" },
  { id: "b", rowIndex: 1, userText: "Second question", assistantText: "Second answer" },
];

async function renderMinimap(onSelect = vi.fn()) {
  const screen = await render(
    <div style={{ position: "relative", height: 400 }}>
      <TimelineMinimap
        hasPersistentGutter
        hitStripWidth={24}
        currentIndex={0}
        items={items}
        stripMap={new Map()}
        onWheel={() => {}}
        onSelect={onSelect}
      />
    </div>,
  );
  const jump = screen.container.querySelector<HTMLButtonElement>(
    'button[aria-label^="Jump to message"]',
  );
  if (!jump) throw new Error("missing minimap jump button");
  return { screen, jump, onSelect };
}

describe("TimelineMinimap hover previews", () => {
  it("shows the message preview by default", async () => {
    settingsOverrides.hoverPreviews = true;
    const { screen, jump } = await renderMinimap();
    await using _ = screen;

    await act(() => jump.focus());

    const preview = screen.container.querySelector("[data-minimap-preview]");
    expect(preview?.textContent).toContain("First question");
  });

  it("hides the preview but keeps navigation when previews are off", async () => {
    settingsOverrides.hoverPreviews = false;
    const { screen, jump, onSelect } = await renderMinimap();
    await using _ = screen;

    await act(() => jump.focus());
    expect(screen.container.querySelector("[data-minimap-preview]")).toBeNull();

    await act(() => {
      jump.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(() => {
      jump.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith(items[1]);
  });
});

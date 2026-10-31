import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
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

function setup({ hoverPreviews }: { hoverPreviews: boolean }) {
  settingsOverrides.hoverPreviews = hoverPreviews;
}

async function renderFocusedMinimap(onSelect = vi.fn()) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <div className="relative h-[400px]">
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
    ),
  );
  const jump = page.getByRole("button", { name: /Jump to message/ });
  await expect.element(jump).toBeInTheDocument();
  jump.element().focus();
  const disposables = stack.move();
  return { screen, onSelect, [Symbol.asyncDispose]: () => disposables.disposeAsync() };
}

describe("TimelineMinimap hover previews", () => {
  it("shows the message preview by default", async () => {
    setup({ hoverPreviews: true });
    await using _ = await renderFocusedMinimap();

    await expect.element(page.getByText("First answer")).toBeVisible();
  });

  it("hides the preview but keeps navigation when previews are off", async () => {
    setup({ hoverPreviews: false });
    await using minimap = await renderFocusedMinimap();

    await expect.element(page.getByText("First answer")).not.toBeInTheDocument();
    const jump = page.getByRole("button", { name: /Jump to message/ });
    await vi.waitFor(() => expect(jump.element().getBoundingClientRect().width).toBe(24));
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await vi.waitFor(() => expect(minimap.onSelect).toHaveBeenCalledWith(items[1]));
  });
});

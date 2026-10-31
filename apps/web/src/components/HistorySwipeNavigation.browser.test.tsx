import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { HistorySwipeNavigation } from "./HistorySwipeNavigation";

type Scroller = "shadow" | "light" | "none" | "shadow-dialog";
// Each step is one wheel event, optionally followed by the scroll it caused.
type Step = readonly [deltaX: number, scrollLeftAfter?: number];

function mountPanel(container: HTMLElement, scroller: Scroller, scrollLeft: number) {
  const panel = container.appendChild(document.createElement("div"));
  const root = scroller.startsWith("shadow") ? panel.attachShadow({ mode: "open" }) : panel;
  const parent =
    scroller === "shadow-dialog"
      ? root.appendChild(Object.assign(document.createElement("div"), { role: "dialog" }))
      : root;
  const overflows = scroller === "shadow" || scroller === "light";
  const viewport = parent.appendChild(document.createElement("div"));
  viewport.style.cssText = `width: 200px; overflow-x: ${overflows ? "auto" : "visible"}`;
  const content = viewport.appendChild(document.createElement("div"));
  content.style.cssText = `height: 20px; width: ${overflows ? 1000 : 100}px`;
  viewport.scrollLeft = scrollLeft;
  return { viewport, content };
}

describe("HistorySwipeNavigation", () => {
  it.each<[string, Scroller, number, readonly Step[], "back" | "forward" | null]>([
    ["scrolling left inside a shadow-root scroller", "shadow", 400, [[-130]], null],
    ["scrolling right inside a shadow-root scroller", "shadow", 400, [[130]], null],
    ["swiping left at a shadow-root scroller's left edge", "shadow", 0, [[-130]], null],
    ["swiping right at a shadow-root scroller's right edge", "shadow", 800, [[130]], null],
    ["swiping left at a scroller's left edge", "light", 0, [[-130]], null],
    ["swiping right at a scroller's right edge", "light", 800, [[130]], null],
    ["scrolling left inside a scroller", "light", 400, [[-130]], null],
    ["a small first event that reaches the left edge", "shadow", 3, [[-3, 0], [-130]], null],
    ["a small first event that reaches the right edge", "light", 797, [[3, 800], [130]], null],
    ["a scroll that reaches the edge mid-gesture", "light", 100, [[-100, 0], [-130]], null],
    ["swiping inside a dialog in a shadow root", "shadow-dialog", 0, [[-130]], null],
    ["swiping left over content without overflow", "none", 0, [[-130]], "back"],
    ["swiping right over content without overflow", "none", 0, [[130]], "forward"],
  ])("%s", async (_name, scroller, scrollLeft, steps, navigates) => {
    await using screen = await render(<HistorySwipeNavigation />);
    using back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    using forward = vi.spyOn(window.history, "forward").mockImplementation(() => undefined);
    using _canGoBack = vi.spyOn(window.navigation, "canGoBack", "get").mockReturnValue(true);
    using _canGoForward = vi.spyOn(window.navigation, "canGoForward", "get").mockReturnValue(true);
    const { viewport, content } = mountPanel(screen.container, scroller, scrollLeft);

    for (const [deltaX, scrollLeftAfter] of [...steps, [0] as const]) {
      content.dispatchEvent(new WheelEvent("wheel", { deltaX, bubbles: true, composed: true }));
      if (scrollLeftAfter !== undefined) viewport.scrollLeft = scrollLeftAfter;
    }

    expect(back).toHaveBeenCalledTimes(navigates === "back" ? 1 : 0);
    expect(forward).toHaveBeenCalledTimes(navigates === "forward" ? 1 : 0);
  });
});

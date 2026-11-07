import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../test/render";
import { HistorySwipeNavigation } from "./HistorySwipeNavigation";

type Scroller = "shadow" | "none" | "shadow-dialog";
type Step = readonly [
  event: number | "begin" | "end" | "show-scroller" | "gain-overflow",
  after?: "remove" | "close-dialog",
];

function mountPanel(container: HTMLElement, scroller: Scroller, scrollLeft: number) {
  const panel = container.appendChild(document.createElement("div"));
  const root = scroller.startsWith("shadow") ? panel.attachShadow({ mode: "open" }) : panel;
  const parent =
    scroller === "shadow-dialog"
      ? root.appendChild(Object.assign(document.createElement("div"), { role: "dialog" }))
      : root;
  const overflows = scroller === "shadow";
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
    ["swiping left at a shadow-root scroller's left edge", "shadow", 0, [[-130]], null],
    ["a scroller removed after a small first event", "shadow", 400, [[1, "remove"], [130]], null],
    [
      "a history gesture after a content scroll ends",
      "shadow",
      400,
      [[1, "remove"], ["end"], ["begin"], [130]],
      "forward",
    ],
    [
      "content appearing under tracking that a trailing history wheel started",
      "none",
      0,
      [["begin"], [130], ["end"], [18], ["show-scroller"], ["begin"], [7], [130], ["end"]],
      "forward",
    ],
    [
      "a gesture that starts in a dialog before it closes",
      "shadow-dialog",
      0,
      [[-1, "close-dialog"], [-130]],
      null,
    ],
    [
      "a history swipe over content replaced without overflow, released over a scroller",
      "none",
      0,
      [[-60, "remove"], [-70], ["show-scroller"]],
      "back",
    ],
    [
      "a history swipe whose target gains overflow",
      "none",
      0,
      [[-60], ["gain-overflow"], [-70]],
      "back",
    ],
  ])("%s", async (_name, scroller, scrollLeft, steps, navigates) => {
    const listeners = { begin: new Set<() => void>(), end: new Set<() => void>() };
    using _bridge = stubGlobal("desktopBridge", {
      onTrackpadScrollBegin: (listener: () => void) => {
        listeners.begin.add(listener);
        return () => listeners.begin.delete(listener);
      },
      onTrackpadScrollEnd: (listener: () => void) => {
        listeners.end.add(listener);
        return () => listeners.end.delete(listener);
      },
    });
    await using screen = await render(<HistorySwipeNavigation />);
    using back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    using forward = vi.spyOn(window.history, "forward").mockImplementation(() => undefined);
    using _canGoBack = vi.spyOn(window.navigation, "canGoBack", "get").mockReturnValue(true);
    using _canGoForward = vi.spyOn(window.navigation, "canGoForward", "get").mockReturnValue(true);
    let { viewport, content } = mountPanel(screen.container, scroller, scrollLeft);

    for (const [event, after] of [...steps, [0] as const]) {
      if (event === "begin") {
        for (const listener of listeners.begin) listener();
      } else if (event === "end") {
        for (const listener of listeners.end) listener();
      } else if (event === "show-scroller") {
        ({ viewport, content } = mountPanel(screen.container, "shadow", 400));
      } else if (event === "gain-overflow") {
        viewport.style.overflowX = "auto";
        content.style.width = "1000px";
      } else {
        content.dispatchEvent(
          new WheelEvent("wheel", { deltaX: event, bubbles: true, composed: true }),
        );
      }
      if (after === "remove") {
        viewport.remove();
        ({ viewport, content } = mountPanel(screen.container, "none", 0));
      } else if (after === "close-dialog") {
        viewport.parentElement!.remove();
        screen.container.appendChild(viewport);
      }
    }

    expect(back).toHaveBeenCalledTimes(navigates === "back" ? 1 : 0);
    expect(forward).toHaveBeenCalledTimes(navigates === "forward" ? 1 : 0);
  });
});

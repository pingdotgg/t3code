import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../test/render";
import { HistorySwipeNavigation } from "./HistorySwipeNavigation";

type Scroller = "shadow" | "light" | "none" | "shadow-dialog";
// The page's Date.now() minus its performance.now(); main stamps the end with Date.now().
const WALL_CLOCK_AHEAD = 1_700_000_000_000;
// Every gesture IPC reaches the page this long after main sees the native event.
const IPC_LAG = 40;
type Step = readonly [
  // "stale": a 1px wheel created before main saw the last end, delivered after its IPC.
  // "fresh": a 1px wheel created after main saw the last end, before its IPC arrived.
  event: number | "begin" | "end" | "zoom" | "stale" | "fresh",
  after?: number | "remount" | "remove" | "close-dialog",
];

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
    [
      "a scroller remounted after a small first event",
      "shadow",
      400,
      [[1, "remount"], [130]],
      null,
    ],
    ["a scroller removed after a small first event", "shadow", 400, [[1, "remove"], [130]], null],
    [
      "a scroll begin arriving after the first wheel and scroller removal",
      "shadow",
      400,
      [[1, "remove"], ["begin"], [130]],
      null,
    ],
    [
      "a new history gesture after a content scroll ends",
      "shadow",
      400,
      [[1, "remove"], ["end"], ["begin"], [130]],
      "forward",
    ],
    [
      "a history gesture after a stale wheel reaches a scroller",
      "shadow",
      400,
      [["begin"], [130], ["end"], ["stale", "remove"], ["begin"], [-130]],
      "back",
    ],
    [
      "a scroll begin arriving after the next gesture's first wheel and scroller removal",
      "shadow",
      400,
      [["begin"], [130], ["end"], [1, "remove"], ["begin"], [130]],
      null,
    ],
    [
      "a next-gesture wheel created while the previous end IPC was in flight",
      "shadow",
      400,
      [["begin"], [130], ["end"], ["fresh", "remove"], ["begin"], [130]],
      null,
    ],
    [
      "a history gesture after zero-delta contact on a scroller",
      "shadow",
      400,
      [[0, "remove"], ["begin"], [130]],
      "forward",
    ],
    [
      "a scroll begin after an ignored zoom wheel",
      "none",
      0,
      [["zoom"], ["begin"], [130]],
      "forward",
    ],
    ["swiping inside a dialog in a shadow root", "shadow-dialog", 0, [[-130]], null],
    [
      "a gesture that starts in a dialog before it closes",
      "shadow-dialog",
      0,
      [[-1, "close-dialog"], [-130]],
      null,
    ],
    ["swiping left over content without overflow", "none", 0, [[-130]], "back"],
    ["swiping right over content without overflow", "none", 0, [[130]], "forward"],
  ])("%s", async (_name, scroller, scrollLeft, steps, navigates) => {
    type Listener = (at: number) => void;
    const listeners = { begin: new Set<() => void>(), end: new Set<Listener>() };
    using _bridge = stubGlobal("desktopBridge", {
      onTrackpadScrollBegin: (listener: () => void) => {
        listeners.begin.add(listener);
        return () => listeners.begin.delete(listener);
      },
      onTrackpadScrollEnd: (listener: Listener) => {
        listeners.end.add(listener);
        return () => listeners.end.delete(listener);
      },
    });
    await using screen = await render(<HistorySwipeNavigation />);
    using back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    using forward = vi.spyOn(window.history, "forward").mockImplementation(() => undefined);
    using _canGoBack = vi.spyOn(window.navigation, "canGoBack", "get").mockReturnValue(true);
    using _canGoForward = vi.spyOn(window.navigation, "canGoForward", "get").mockReturnValue(true);
    let now = 1000;
    let endSeenAt = 0;
    using _now = vi.spyOn(performance, "now").mockImplementation(() => now);
    using _wallNow = vi.spyOn(Date, "now").mockImplementation(() => now + WALL_CLOCK_AHEAD);
    let { viewport, content } = mountPanel(screen.container, scroller, scrollLeft);

    for (const [event, after] of [...steps, [0] as const]) {
      now += 10;
      if (event === "begin") {
        now += IPC_LAG;
        for (const listener of listeners.begin) listener();
      } else if (event === "end") {
        endSeenAt = now;
        now += IPC_LAG;
        for (const listener of listeners.end) listener(endSeenAt + WALL_CLOCK_AHEAD);
      } else {
        const wheel = new WheelEvent("wheel", {
          deltaX: typeof event === "number" ? event : event === "zoom" ? 0 : 1,
          ctrlKey: event === "zoom",
          bubbles: true,
          composed: true,
        });
        const timeStamp =
          event === "stale" ? endSeenAt - 5 : event === "fresh" ? endSeenAt + IPC_LAG / 2 : now;
        Object.defineProperty(wheel, "timeStamp", { value: timeStamp });
        content.dispatchEvent(wheel);
      }
      if (after === "remount") {
        const replacement = viewport.cloneNode(true) as HTMLDivElement;
        const { scrollLeft: previous } = viewport;
        viewport.replaceWith(replacement);
        replacement.scrollLeft = previous;
        viewport = replacement;
        content = replacement.firstElementChild as HTMLDivElement;
      } else if (after === "remove") {
        viewport.remove();
        ({ viewport, content } = mountPanel(screen.container, "none", 0));
      } else if (after === "close-dialog") {
        viewport.parentElement!.remove();
        screen.container.appendChild(viewport);
      } else if (after !== undefined) {
        viewport.scrollLeft = after;
      }
    }

    expect(back).toHaveBeenCalledTimes(navigates === "back" ? 1 : 0);
    expect(forward).toHaveBeenCalledTimes(navigates === "forward" ? 1 : 0);
  });
});

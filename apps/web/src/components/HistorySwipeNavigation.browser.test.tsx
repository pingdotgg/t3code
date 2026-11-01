import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../test/render";
import { HistorySwipeNavigation } from "./HistorySwipeNavigation";

type Scroller = "shadow" | "light" | "none" | "shadow-dialog";
type Step = readonly [
  // "move" and "move-to-scroller": the wheel position moves to new content elsewhere.
  event:
    | number
    | "begin"
    | "end"
    | "zoom"
    | "move"
    | "move-to-scroller"
    | "show-scroller"
    | "close-by-key"
    | "pointer-return",
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
  it.each<
    [
      string,
      Scroller,
      number,
      readonly Step[],
      "back" | "forward" | "both" | null,
      ("back" | "forward")?,
    ]
  >([
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
      "a history gesture elsewhere after a content scroll ends",
      "shadow",
      400,
      [[1, "remove"], ["end"], ["move"], ["begin"], [130]],
      "forward",
    ],
    [
      "a history gesture elsewhere after a trailing wheel reaches a scroller",
      "shadow",
      400,
      [["begin"], [130], ["end"], [1, "remount"], ["move"], ["begin"], [-130]],
      "back",
    ],
    [
      "a history gesture at the same position after closing content by keyboard",
      "shadow",
      400,
      [[1], ["end"], ["close-by-key", "remove"], ["begin"], [-130]],
      "back",
    ],
    [
      "a history gesture after moving the pointer away and back to removed content",
      "shadow",
      400,
      [[1, "remove"], ["end"], ["pointer-return"], ["begin"], [130]],
      "forward",
    ],
    [
      "content scrolling after a trailing history wheel started tracking elsewhere",
      "none",
      0,
      [
        ["begin"],
        [130],
        ["end"],
        [18],
        ["move-to-scroller"],
        [7, "remount"],
        ["begin"],
        [130],
        ["end"],
      ],
      "forward",
    ],
    [
      "content appearing at the same position after a trailing history wheel",
      "none",
      0,
      [
        ["begin"],
        [130],
        ["end"],
        [18],
        ["show-scroller"],
        ["begin"],
        [7, "remove"],
        [130],
        ["end"],
      ],
      "forward",
    ],
    [
      "a history swipe over content replaced without overflow",
      "none",
      0,
      [[60, "remove"], [70]],
      "forward",
    ],
    [
      "the next gesture's first wheel arriving before the previous end, then scroller removal",
      "shadow",
      400,
      [["begin"], [130], [1, "remove"], ["end"], ["begin"], [130]],
      null,
    ],
    [
      "a scroll begin arriving after the next gesture's first wheel and scroller removal",
      "shadow",
      400,
      [["begin"], [130], ["end"], [1, "remove"], ["begin"], [130]],
      null,
    ],
    [
      "a reversed next swipe whose first wheel beats its begin, after a trailing wheel",
      "none",
      0,
      [
        ["begin"],
        [-130],
        ["end"],
        [-23.5560302734375],
        [23.84126091003418],
        ["begin"],
        [130],
        ["end"],
      ],
      "both",
    ],
    [
      "a reversed next swipe whose begin beats its first wheel, after a trailing wheel",
      "none",
      0,
      [
        ["begin"],
        [130],
        ["end"],
        [23.5560302734375],
        ["begin"],
        [-23.84126091003418],
        [-130],
        ["end"],
      ],
      "both",
    ],
    [
      "a reversed swipe needs its first wheel from before a late begin",
      "none",
      0,
      [["begin"], [-130], ["end"], [-23.5560302734375], [60], ["begin"], [100], ["end"]],
      "both",
    ],
    [
      "a swipe resumes after reversing toward unavailable history",
      "none",
      0,
      [["begin"], [-80], [100], [-130], ["end"]],
      "back",
      "forward",
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
  ])("%s", async (_name, scroller, scrollLeft, steps, navigates, unavailable) => {
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
    using _canGoBack = vi
      .spyOn(window.navigation, "canGoBack", "get")
      .mockReturnValue(unavailable !== "back");
    using _canGoForward = vi
      .spyOn(window.navigation, "canGoForward", "get")
      .mockReturnValue(unavailable !== "forward");
    let { viewport, content } = mountPanel(screen.container, scroller, scrollLeft);
    let pointerX = 0;

    for (const [event, after] of [...steps, [0] as const]) {
      if (event === "begin") {
        for (const listener of listeners.begin) listener();
      } else if (event === "end") {
        for (const listener of listeners.end) listener();
      } else if (event === "move") {
        ({ viewport, content } = mountPanel(screen.container, "none", 0));
        pointerX += 100;
      } else if (event === "move-to-scroller" || event === "show-scroller") {
        ({ viewport, content } = mountPanel(screen.container, "shadow", 400));
        if (event === "move-to-scroller") pointerX += 100;
      } else if (event === "close-by-key") {
        content.dispatchEvent(
          new KeyboardEvent("keydown", { key: "d", metaKey: true, bubbles: true, composed: true }),
        );
      } else if (event === "pointer-return") {
        for (const clientX of [pointerX + 100, pointerX]) {
          content.dispatchEvent(
            new PointerEvent("pointermove", { clientX, bubbles: true, composed: true }),
          );
        }
      } else {
        content.dispatchEvent(
          new WheelEvent("wheel", {
            deltaX: event === "zoom" ? 0 : event,
            ctrlKey: event === "zoom",
            clientX: pointerX,
            bubbles: true,
            composed: true,
          }),
        );
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

    expect(back).toHaveBeenCalledTimes(navigates === "back" || navigates === "both" ? 1 : 0);
    expect(forward).toHaveBeenCalledTimes(navigates === "forward" || navigates === "both" ? 1 : 0);
  });
});

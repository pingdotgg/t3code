import type { TrackpadScrollPhase } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../test/render";
import { HistorySwipeNavigation } from "./HistorySwipeNavigation";

const navigateHistory = vi.hoisted(() => vi.fn());
vi.mock("../navigationHistory", () => ({ canNavigateHistory: () => true, navigateHistory }));

function swipe(target: Element, deltaX: number) {
  for (const delta of [deltaX, 0]) {
    target.dispatchEvent(new WheelEvent("wheel", { deltaX: delta, bubbles: true, composed: true }));
  }
}

describe("HistorySwipeNavigation", () => {
  it.each([
    ["scrolling left inside a shadow-root scroller keeps the thread", "shadow", 100, -130, false],
    ["scrolling right inside a shadow-root scroller keeps the thread", "shadow", 100, 130, false],
    [
      "scrolling after a shadow scroller remount keeps the thread",
      "shadow-remount",
      100,
      130,
      false,
    ],
    ["scrolling left inside a scroller keeps the thread", "light", 100, -130, false],
    ["scrolling at a shadow-root scroller's left edge keeps the thread", "shadow", 0, -130, false],
    [
      "scrolling at a shadow-root scroller's right edge keeps the thread",
      "shadow",
      800,
      130,
      false,
    ],
    ["scrolling at a scroller's left edge keeps the thread", "light", 0, -130, false],
    ["scrolling at a scroller's right edge keeps the thread", "light", 800, 130, false],
    ["scrolling over a preview panel keeps the thread", "preview-panel", 0, -130, false],
    ["scrolling over a desktop preview keeps the thread", "preview-viewport", 0, 130, false],
    ["scrolling over a streamed preview keeps the thread", "server-browser", 0, -130, false],
    ["swiping back over a panel without overflow navigates", "none", 0, -130, true],
    ["a swipe that started in a closed dialog keeps the thread", "closed-dialog", 0, -130, false],
    ["swiping back over an open alert dialog keeps the thread", "alertdialog", 0, -130, false],
  ] as const)("%s", async (_name, scroller, scrollLeft, deltaX, navigates) => {
    navigateHistory.mockReset();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using screen = await render(<HistorySwipeNavigation />);
    const panel = screen.container.appendChild(document.createElement("div"));
    const root = scroller.startsWith("shadow") ? panel.attachShadow({ mode: "open" }) : panel;
    const viewport = root.appendChild(document.createElement("div"));
    const noOverflow = !scroller.startsWith("shadow") && scroller !== "light";
    if (scroller === "preview-panel") panel.setAttribute("data-preview-panel-mode", "inline");
    if (scroller === "preview-viewport") panel.setAttribute("data-preview-viewport", "tab");
    if (scroller === "server-browser") panel.setAttribute("data-server-browser-surface", "tab");
    if (scroller === "alertdialog") panel.setAttribute("role", "alertdialog");
    viewport.style.cssText = `width: 200px; overflow-x: ${noOverflow ? "visible" : "auto"}`;
    const content = viewport.appendChild(document.createElement("div"));
    content.style.cssText = `height: 20px; width: ${noOverflow ? 100 : 1000}px`;
    viewport.scrollLeft = scrollLeft;

    if (scroller === "closed-dialog") {
      panel.setAttribute("role", "dialog");
      content.dispatchEvent(new WheelEvent("wheel", { deltaX: -1, bubbles: true, composed: true }));
      panel.remove();
      screen.container.appendChild(viewport);
    }

    if (scroller === "shadow-remount") {
      content.dispatchEvent(new WheelEvent("wheel", { deltaX: 1, bubbles: true, composed: true }));
      const replacement = viewport.cloneNode(true) as HTMLDivElement;
      viewport.replaceWith(replacement);
      replacement.scrollLeft = scrollLeft;
      swipe(replacement, deltaX);
    } else {
      swipe(content, deltaX);
    }

    expect(navigateHistory).toHaveBeenCalledTimes(navigates ? 1 : 0);
  });

  it.each([
    ["end", "back", -130, "wheel first", true],
    ["end", "forward", 130, "release first", true],
    ["end", "back", -130, "next from edge", false],
    ["end", "back", -130, "next wheel before begin", true],
    ["end", "back", -130, "vertical wheel before begin", false],
    ["end", "back", -112, "a wobble past the origin", true],
    ["end", "back", -130, "shift held", false],
    ["end", "back", -80, "wheel first", false],
    ["cancel", "back", -130, "wheel first", false],
  ] as const)(
    "uses native %s for a %s swipe of %s px with %s",
    async (phase, direction, deltaX, order, commit) => {
      navigateHistory.mockReset();
      const listeners = new Set<(phase: TrackpadScrollPhase) => void>();
      const scrollEnds = new Set<() => void>();
      using _bridge = stubGlobal("desktopBridge", {
        onTrackpadScrollBegin: () => () => {},
        onTrackpadScrollEnd: (listener: () => void) => {
          scrollEnds.add(listener);
          return () => scrollEnds.delete(listener);
        },
        onTrackpadScrollPhase: (listener: (phase: TrackpadScrollPhase) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      });
      using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      await using screen = await render(<HistorySwipeNavigation />);
      const content = screen.container.appendChild(document.createElement("div"));
      const sendPhase = (phase: TrackpadScrollPhase) =>
        listeners.forEach((listener) => listener(phase));
      const nextFromScroller = order === "next from edge";
      if (nextFromScroller) {
        content.style.cssText = "width: 100px; overflow-x: auto";
        const child = content.appendChild(document.createElement("div"));
        child.style.cssText = "width: 400px; height: 20px";
      }
      const firstWheel = new WheelEvent("wheel", {
        deltaX: deltaX * 0.2,
        bubbles: true,
        shiftKey: order === "shift held",
      });
      const at = 1_000_000;
      using _now = vi.spyOn(Date, "now").mockReturnValue(at);
      using _performance = vi.spyOn(performance, "now").mockReturnValue(firstWheel.timeStamp);

      // Chromium's first wheel can arrive before IPC, and the last wheel can arrive after it.
      if (nextFromScroller || order.endsWith("before begin")) {
        sendPhase({ kind: "begin", at: at - 100 });
        sendPhase({ kind: "cancel", at: at - 10 });
      }
      if (order === "vertical wheel before begin") {
        content.dispatchEvent(new WheelEvent("wheel", { deltaY: 12, bubbles: true }));
      }
      if (order !== "release first") content.dispatchEvent(firstWheel);
      sendPhase({ kind: "begin", at });
      if (order === "wheel first") {
        content.dispatchEvent(new WheelEvent("wheel", { deltaX: deltaX * 0.2, bubbles: true }));
      }
      if (order === "a wobble past the origin") {
        // Native net delta is -112, but the wheel distance clamps at the origin and reaches 130.
        for (const delta of [40, -130]) {
          content.dispatchEvent(new WheelEvent("wheel", { deltaX: delta, bubbles: true }));
        }
      }
      scrollEnds.forEach((listener) => listener());
      expect(navigateHistory).not.toHaveBeenCalled();
      sendPhase(
        phase === "end"
          ? {
              kind: phase,
              at: at + 1,
              deltaX,
              travelX: Math.abs(deltaX),
              travelY: 0,
            }
          : { kind: phase, at: at + 1 },
      );
      if (order === "release first") {
        expect(navigateHistory).not.toHaveBeenCalled();
        content.dispatchEvent(firstWheel);
      }
      expect(navigateHistory.mock.calls).toEqual(commit ? [[direction]] : []);

      swipe(content, deltaX * 2);
      scrollEnds.forEach((listener) => listener());
      expect(navigateHistory).toHaveBeenCalledTimes(commit ? 1 : 0);
    },
  );

  it("a horizontal mouse wheel tick off macOS keeps the thread", async () => {
    navigateHistory.mockReset();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    await using screen = await render(<HistorySwipeNavigation />);
    const content = screen.container.appendChild(document.createElement("div"));
    content.style.cssText = "height: 20px; width: 100px";

    swipe(content, -120);

    expect(navigateHistory).not.toHaveBeenCalled();
  });

  it.each([
    ["Shift-scroll keeps the thread", [[-130, true]]],
    [
      "pressing Shift during a swipe cancels navigation",
      [
        [-130, false],
        [-1, true],
      ],
    ],
    [
      "releasing Shift during a scroll keeps the thread",
      [
        [-1, true],
        [-130, false],
      ],
    ],
  ] as const)("%s", async (_name, events) => {
    navigateHistory.mockReset();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using screen = await render(<HistorySwipeNavigation />);
    for (const [deltaX, shiftKey] of [...events, [0, false] as const]) {
      screen.container.dispatchEvent(new WheelEvent("wheel", { deltaX, shiftKey, bubbles: true }));
    }
    expect(navigateHistory).not.toHaveBeenCalled();
  });

  // A vertical scroll 15° off vertical.
  const drift = Array.from({ length: 30 }, () => [-4, 15] as const);
  it.each([
    [
      "a vertical scroll that starts slightly diagonally keeps the thread",
      [[-5, 3], ...drift],
      false,
    ],
    [
      "a swipe that leans diagonally for two events navigates",
      [
        [-5, 3],
        [-2, 2],
        [-150, 0],
      ],
      true,
    ],
    ["a single diagonal event past the trigger keeps the thread", [[-130, 100]], false],
  ] as const)("%s", async (_name, events, navigates) => {
    navigateHistory.mockReset();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using screen = await render(<HistorySwipeNavigation />);
    const panel = screen.container.appendChild(document.createElement("div"));
    for (const [deltaX, deltaY] of [...events, [0, 0] as const]) {
      panel.dispatchEvent(
        new WheelEvent("wheel", { deltaX, deltaY, bubbles: true, composed: true }),
      );
    }

    expect(navigateHistory).toHaveBeenCalledTimes(navigates ? 1 : 0);
  });
});

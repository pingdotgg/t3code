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
    ["swiping back at a shadow-root scroller's left edge navigates", "shadow", 0, -130, true],
    ["swiping back over a panel without overflow navigates", "none", 0, -130, true],
    ["a swipe that started in a closed dialog keeps the thread", "closed-dialog", 0, -130, false],
  ] as const)("%s", async (_name, scroller, scrollLeft, deltaX, navigates) => {
    navigateHistory.mockReset();
    await using screen = await render(<HistorySwipeNavigation />);
    const panel = screen.container.appendChild(document.createElement("div"));
    const root = scroller.startsWith("shadow") ? panel.attachShadow({ mode: "open" }) : panel;
    const viewport = root.appendChild(document.createElement("div"));
    const noOverflow = scroller === "none" || scroller === "closed-dialog";
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
    [
      "a macOS trackpad swipe navigates",
      1,
      [
        [-4, 12],
        [-60, 180],
        [-60, 180],
      ],
      true,
    ],
    ["an accelerated macOS mouse wheel notch keeps the thread", 1, [[-200, 240]], false],
    [
      "slow macOS mouse wheel notches keep the thread",
      1,
      [
        [-40, 120],
        [-40, 120],
        [-40, 120],
      ],
      false,
    ],
    ["a macOS mouse wheel notch at 120% zoom keeps the thread", 1.2, [[-166.67, 200]], false],
    ["a macOS mouse wheel notch at 110% zoom keeps the thread", 1.1, [[-181.82, 218]], false],
    ["a Linux horizontal mouse wheel notch keeps the thread", 1, [[-120, 120]], false],
  ] as const)("%s", async (_name, zoomFactor, events, navigates) => {
    navigateHistory.mockReset();
    using _bridge = stubGlobal("desktopBridge", {
      getWindowZoomFactor: () => zoomFactor,
      onTrackpadScrollBegin: () => () => {},
      onTrackpadScrollEnd: () => () => {},
    });
    await using screen = await render(<HistorySwipeNavigation />);
    const target = screen.container.appendChild(document.createElement("div"));
    for (const [deltaX, wheelDeltaX] of [...events, [0, 0]]) {
      const init = { deltaX, wheelDeltaX, bubbles: true };
      target.dispatchEvent(new WheelEvent("wheel", init));
    }
    expect(navigateHistory).toHaveBeenCalledTimes(navigates ? 1 : 0);
  });
});

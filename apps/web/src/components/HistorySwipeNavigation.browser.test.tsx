import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
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
    [
      "a diagonal start followed by vertical scrolling",
      [
        [-5, 3],
        [-5, 15],
        [-40, 200],
        [-40, 200],
        [-40, 200],
      ],
      false,
    ],
    [
      "a mostly diagonal gesture",
      [
        [-30, 20],
        [-100, 100],
      ],
      false,
    ],
    [
      "a horizontal start that turns vertical after arming",
      [
        [-30, 0],
        [-100, 0],
        [0, 100],
        [-200, 0],
      ],
      false,
    ],
    [
      "vertical movement in alternating directions before axis lock",
      [
        [-10, 5],
        [-10, -5],
        [-110, 0],
      ],
      false,
    ],
    [
      "vertical movement in alternating directions",
      [
        [-30, 5],
        [-50, 60],
        [-50, -60],
      ],
      false,
    ],
    [
      "vertical movement as horizontal momentum starts",
      [
        [-30, 0],
        [-50, 0],
        [-45, 0],
        [-40.5, 0],
        [-36.45, 0],
        [-32.805, 200],
      ],
      false,
    ],
    [
      "a deliberate swipe released by horizontal momentum",
      [
        [-30, 0],
        [-50, 0],
        [-45, 0],
        [-40.5, 0],
        [-36.45, 0],
        [-32.805, 0],
      ],
      true,
    ],
    [
      "a deliberate back swipe with slight vertical drift",
      [
        [-5, 3],
        [-25, 1],
        [-100, 5],
      ],
      true,
    ],
    [
      "a deliberate forward swipe with slight vertical drift",
      [
        [10, 1],
        [20, 1],
        [100, 5],
      ],
      true,
    ],
  ] as const)("%s", async (_name, deltas, navigates) => {
    navigateHistory.mockReset();
    await using screen = await render(<HistorySwipeNavigation />);
    for (const [deltaX, deltaY] of [...deltas, [0, 0]]) {
      screen.container.dispatchEvent(new WheelEvent("wheel", { deltaX, deltaY, bubbles: true }));
    }
    expect(navigateHistory).toHaveBeenCalledTimes(navigates ? 1 : 0);
    if (navigates) {
      expect(navigateHistory).toHaveBeenCalledWith(deltas[0][0] < 0 ? "back" : "forward");
    }
  });

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
});

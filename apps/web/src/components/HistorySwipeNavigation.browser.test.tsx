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

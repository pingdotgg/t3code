import { describe, expect, it, vi } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { attachTimelineViewport } from "../components/chat/timelineViewport";

const words = "the reader selects a line of this answer to cite it in a reply ".repeat(40);

describe("timeline selection drag", () => {
  it("reports the autoscroll of a selection dragged to the top edge, not a clamp during a press", async () => {
    await using screen = await render(
      <div data-testid="above" style={{ paddingTop: 120 }}>
        <div
          data-testid="timeline"
          style={{ height: 300, width: 400, overflowY: "auto", overflowAnchor: "none" }}
        >
          <div data-testid="tail" style={{ height: 900 }} />
          <p style={{ margin: 0 }}>{words}</p>
          <p data-testid="last" style={{ margin: 0 }}>
            {words}
          </p>
        </div>
      </div>,
      // A plain scroller; the viewport needs no routes.
      { router: false },
    );
    const timeline = screen.getByTestId("timeline").element() as HTMLElement;
    const last = screen.getByTestId("last").element() as HTMLElement;
    const tail = screen.getByTestId("tail").element() as HTMLElement;
    const above = screen.getByTestId("above").element() as HTMLElement;
    const frame = window.frameElement?.getBoundingClientRect();
    const mouse = (type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) =>
      cdp().send("Input.dispatchMouseEvent", {
        type,
        x: x + (frame?.left ?? 0),
        y: y + (frame?.top ?? 0),
        button: "left",
        buttons: type === "mouseReleased" ? 0 : 1,
        clickCount: 1,
      });
    const scrolled = () =>
      new Promise<void>((resolve) =>
        timeline.addEventListener("scroll", () => resolve(), { once: true }),
      );
    const toEnd = async () => {
      const scroll = scrolled();
      timeline.scrollTop = timeline.scrollHeight;
      await scroll;
    };
    // Content that shrinks and grows back in one task clamps scrollTop with no input at all.
    const clamp = async () => {
      const scroll = scrolled();
      tail.style.height = "100px";
      void timeline.scrollTop;
      tail.style.height = "900px";
      await scroll;
    };
    // A line of the last paragraph in the scrolled-to-end view, below the autoscroll edge.
    const textPoint = () => {
      const box = timeline.getBoundingClientRect();
      return { x: box.left + 40, y: box.top + 60 };
    };

    await using stack = new AsyncDisposableStack();
    await toEnd();
    const viewport = attachTimelineViewport(timeline);
    stack.defer(() => viewport.dispose());
    stack.defer(async () => {
      await mouse("mouseReleased", 0, 0);
      document.getSelection()?.removeAllRanges();
    });
    const sources: string[] = [];
    viewport.subscribe((navigation) => {
      if (navigation.source === "scroll") sources.push(navigation.source);
    });

    const start = textPoint();
    // A still press near the top that layout moves above the timeline's edge is no drag.
    const nearTop = { x: start.x, y: timeline.getBoundingClientRect().top + 10 };
    document.getSelection()!.selectAllChildren(last);
    await mouse("mousePressed", nearTop.x, nearTop.y);
    above.style.paddingTop = "160px";
    await clamp();
    await mouse("mouseReleased", nearTop.x, nearTop.y);
    above.style.paddingTop = "120px";
    expect(sources).toEqual([]);

    await toEnd();
    await mouse("mousePressed", start.x, start.y);
    await mouse("mouseMoved", start.x + 120, start.y + 60);
    expect(document.getSelection()!.isCollapsed).toBe(false);
    await clamp();
    await mouse("mouseReleased", start.x + 120, start.y + 60);
    expect(sources).toEqual([]);

    await toEnd();
    const end = timeline.scrollTop;
    // A press on selected text would start a drag of that text instead of a new selection.
    document.getSelection()!.removeAllRanges();
    await mouse("mousePressed", start.x, start.y);
    // Chromium autoscrolls while the pointer is just inside the top edge.
    const edge = { x: start.x + 60, y: timeline.getBoundingClientRect().top + 5 };
    await mouse("mouseMoved", edge.x, edge.y);
    await vi.waitFor(() => expect(timeline.scrollTop).toBeLessThan(end - 100), { timeout: 10_000 });
    await mouse("mouseReleased", edge.x, edge.y);
    const dragScrolls = sources.length;
    expect(dragScrolls).toBeGreaterThan(0);

    // The press ended, so a clamp with the selection still in place is no drag.
    await toEnd();
    await clamp();
    expect(sources).toHaveLength(dragScrolls);
  });
});

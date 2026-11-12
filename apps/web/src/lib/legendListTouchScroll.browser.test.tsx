import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type Ref } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

// The patched LegendList holds corrections only where iOS WebKit's `-webkit-touch-callout`
// is supported, decided when the module loads, so the check is answered before importing it.
const supports = CSS.supports.bind(CSS);
CSS.supports = ((property: string, value?: string) => {
  if (property === "-webkit-touch-callout") return true;
  return value === undefined ? supports(property) : supports(property, value);
}) as typeof CSS.supports;
const { LegendList } = await import("@legendapp/list/react");

const ROW_HEIGHT = 80;

function Rows({
  ref,
  heights,
}: {
  readonly ref: Ref<LegendListRef>;
  readonly heights: ReadonlyArray<number>;
}) {
  return (
    <LegendList
      ref={ref}
      data={heights.map((height, index) => ({ id: `row-${index}`, height }))}
      keyExtractor={(item) => item.id}
      estimatedItemSize={ROW_HEIGHT}
      maintainVisibleContentPosition={{ data: true, size: true }}
      renderItem={({ item }) => <div data-row={item.id} style={{ height: item.height }} />}
      style={{ height: 400 }}
    />
  );
}

async function mountScrolledToRow30() {
  await using stack = new AsyncDisposableStack();
  const listRef = createRef<LegendListRef>();
  let heights: ReadonlyArray<number> = Array.from({ length: 60 }, () => ROW_HEIGHT);
  const screen = stack.use(await render(<Rows ref={listRef} heights={heights} />));
  const query = (selector: string) => {
    const element = screen.container.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`${selector} is not rendered.`);
    return element;
  };
  const content = () => query(".legend-list-content-container");
  const scroller = () => content().parentElement!;
  const rowTop = (index: number) => query(`[data-row="row-${index}"]`).getBoundingClientRect().top;

  await vi.waitFor(() => expect(rowTop(0)).toBe(scroller().getBoundingClientRect().top));
  await act(() => listRef.current?.scrollToOffset({ offset: 30 * ROW_HEIGHT, animated: false }));
  await vi.waitFor(() => expect(scroller().scrollTop).toBe(30 * ROW_HEIGHT));

  const environment = stack.move();
  return {
    content,
    scroller,
    rowTop,
    held: () => -Number(/^translateY\((-?[\d.]+)px\)$/.exec(content().style.transform)?.[1] ?? 0),
    async growRow28By(extra: number) {
      heights = heights.map((height, index) => (index === 28 ? height + extra : height));
      await screen.rerender(<Rows ref={listRef} heights={heights} />);
    },
    touch(type: "touchstart" | "touchend") {
      const touches = [{ identifier: 1, target: scroller() }];
      scroller().dispatchEvent(
        Object.assign(new Event(type, { bubbles: true }), {
          changedTouches: touches,
          touches: type === "touchstart" ? touches : [],
        }),
      );
    },
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

describe("LegendList size corrections during an iOS touch scroll", () => {
  it("scrolls by the correction at once when no finger is down", async () => {
    await using list = await mountScrolledToRow30();
    const scrollTop = list.scroller().scrollTop;
    const anchorTop = list.rowTop(31);

    await list.growRow28By(300);

    await vi.waitFor(() => expect(list.scroller().scrollTop).toBe(scrollTop + 300));
    expect(list.content().style.transform).toBe("");
    expect(list.rowTop(31)).toBe(anchorTop);
  });

  it("holds the correction in a transform until the touch scroll ends", async () => {
    await using list = await mountScrolledToRow30();
    const scrollTop = list.scroller().scrollTop;
    const anchorTop = list.rowTop(31);

    list.touch("touchstart");
    list.scroller().dispatchEvent(new Event("scroll"));
    await list.growRow28By(300);

    await vi.waitFor(() => expect(list.held()).toBeGreaterThanOrEqual(300));
    expect(list.scroller().scrollTop).toBe(scrollTop);
    expect(list.rowTop(31)).toBe(anchorTop);
    const held = list.held();

    // Momentum continues after the finger lifts; scrollend marks the end of the scroll.
    list.touch("touchend");
    expect(list.scroller().scrollTop).toBe(scrollTop);
    list.scroller().dispatchEvent(new Event("scrollend"));

    expect(list.scroller().scrollTop).toBeCloseTo(scrollTop + held, 0);
    expect(list.content().style.transform).toBe("");
    // The scroll offset snaps to whole device pixels, so the row may sit a fraction off.
    expect(list.rowTop(31)).toBeCloseTo(anchorTop, 0);
  });

  it("applies the held correction when the touch was a tap", async () => {
    await using list = await mountScrolledToRow30();
    const scrollTop = list.scroller().scrollTop;

    list.touch("touchstart");
    await list.growRow28By(120);
    await vi.waitFor(() => expect(list.content().style.transform).toBe("translateY(-120px)"));

    list.touch("touchend");

    expect(list.scroller().scrollTop).toBe(scrollTop + 120);
    expect(list.content().style.transform).toBe("");
  });
});

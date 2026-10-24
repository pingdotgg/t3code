import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type Ref } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";

// The patched LegendList defers its scroll corrections only where
// `-webkit-touch-callout` is supported (iOS WebKit), and decides that when the
// module loads, so the check is answered before the list is imported.
const supports = CSS.supports.bind(CSS);
CSS.supports = ((property: string, value?: string) => {
  if (property === "-webkit-touch-callout") return true;
  return value === undefined ? supports(property) : supports(property, value);
}) as typeof CSS.supports;
const { LegendList } = await import("@legendapp/list/react");

const ROW_COUNT = 60;
const ROW_HEIGHT = 80;

interface Row {
  readonly height: number;
  // Bumping it replaces the row's content element, as a re-keyed child would.
  readonly version: number;
}

function Rows({
  ref,
  rows,
}: {
  readonly ref: Ref<LegendListRef>;
  readonly rows: ReadonlyArray<Row>;
}) {
  return (
    <LegendList
      ref={ref}
      data={rows.map((row, index) => ({ id: `row-${index}`, ...row }))}
      keyExtractor={(item) => item.id}
      estimatedItemSize={ROW_HEIGHT}
      maintainVisibleContentPosition={{ data: true, size: true }}
      renderItem={({ item }) => (
        <div data-row={item.id} style={{ height: item.height }}>
          <div key={item.version} data-row-content={item.id}>
            {item.id}
          </div>
        </div>
      )}
      style={{ height: 400 }}
    />
  );
}

// Runs a few frames on fake timers. They stay well short of the patch's 600 ms
// quiet-period fallback, so checks after them see what the touch and scroll
// events did, not the fallback.
async function advanceFrames(count = 4) {
  await act(() => {
    for (let index = 0; index < count; index += 1) vi.advanceTimersToNextFrame();
  });
}

async function mountScrolledToRow(index: number) {
  await using stack = new AsyncDisposableStack();
  const listRef = createRef<LegendListRef>();
  let rows: ReadonlyArray<Row> = Array.from({ length: ROW_COUNT }, () => ({
    height: ROW_HEIGHT,
    version: 0,
  }));
  const screen = stack.use(await render(<Rows ref={listRef} rows={rows} />));
  const updateRow = async (index: number, update: (row: Row) => Row) => {
    rows = rows.map((row, i) => (i === index ? update(row) : row));
    await screen.rerender(<Rows ref={listRef} rows={rows} />);
  };

  const scroller = (): HTMLElement => {
    const element = screen.container.querySelector<HTMLElement>(
      ".legend-list-content-container",
    )?.parentElement;
    if (!element) throw new Error("LegendList scroller is not mounted.");
    return element;
  };
  const contentNode = (): HTMLElement => {
    const element = screen.container.querySelector<HTMLElement>(".legend-list-content-container");
    if (!element) throw new Error("LegendList content container is not mounted.");
    return element;
  };
  const rowTop = (id: string): number => {
    const element = screen.container.querySelector<HTMLElement>(`[data-row="${id}"]`);
    if (!element) throw new Error(`Row ${id} is not rendered.`);
    return element.getBoundingClientRect().top;
  };

  await vi.waitFor(() => expect(rowTop("row-0")).toBe(scroller().getBoundingClientRect().top));
  const offset = index * ROW_HEIGHT;
  await act(async () => {
    await listRef.current?.scrollToOffset({ offset, animated: false });
  });
  // The tests grow the row two above the viewport and anchor on the row below its top.
  await vi.waitFor(() => {
    const viewportTop = scroller().getBoundingClientRect().top;
    expect(scroller().scrollTop).toBe(offset);
    expect(rowTop(`row-${index - 2}`)).toBe(viewportTop - 2 * ROW_HEIGHT);
    expect(rowTop(`row-${index + 1}`)).toBe(viewportTop + ROW_HEIGHT);
  });

  const environment = stack.move();
  return {
    scroller,
    contentNode,
    rowTop,
    heldCorrection(): number {
      const match = /^translateY\((-?[\d.]+)px\)$/.exec(contentNode().style.transform);
      if (!match) throw new Error(`No held correction: "${contentNode().style.transform}".`);
      return -Number(match[1]);
    },
    rowContent(id: string): HTMLElement {
      const element = screen.container.querySelector<HTMLElement>(`[data-row-content="${id}"]`);
      if (!element) throw new Error(`Row ${id} has no content element.`);
      return element;
    },
    // Dispatches a touch event at the element the fingers started on (the scroller
    // unless given), as a browser does: `changed` are the fingers this event is
    // about, `down` every finger on the screen afterwards (TouchEvent.touches).
    touch(
      type: "touchstart" | "touchend",
      changed: ReadonlyArray<number>,
      down: ReadonlyArray<number>,
      target: Element = scroller(),
    ) {
      const touches = (ids: ReadonlyArray<number>) =>
        ids.map((identifier) => ({ identifier, target }));
      target.dispatchEvent(
        Object.assign(new Event(type, { bubbles: true }), {
          changedTouches: touches(changed),
          touches: touches(down),
        }),
      );
    },
    growRow: (row: number, height: number) => updateRow(row, (value) => ({ ...value, height })),
    replaceRowContent: (row: number) =>
      updateRow(row, (value) => ({ ...value, version: value.version + 1 })),
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

describe("LegendList scroll corrections during a touch scroll", () => {
  it("corrects the scroll offset at once when no touch is active", async () => {
    await using list = await mountScrolledToRow(30);
    const scrollTop = list.scroller().scrollTop;
    const anchorTop = list.rowTop("row-31");

    await list.growRow(28, ROW_HEIGHT + 300);

    await vi.waitFor(() => {
      expect(list.scroller().scrollTop).toBe(scrollTop + 300);
      expect(list.contentNode().style.transform).toBe("");
      expect(list.rowTop("row-31")).toBe(anchorTop);
    });
  });

  it("holds corrections in a transform until the touch scroll ends, then takes them in one step", async () => {
    await using list = await mountScrolledToRow(30);
    const scrollTop = list.scroller().scrollTop;
    const anchorTop = list.rowTop("row-31");

    list.touch("touchstart", [1], [1]);
    list.scroller().dispatchEvent(new Event("scroll"));
    await list.growRow(28, ROW_HEIGHT + 300);

    await vi.waitFor(() => {
      expect(list.heldCorrection()).toBeGreaterThanOrEqual(300);
      expect(list.rowTop("row-31")).toBe(anchorTop);
    });
    expect(list.scroller().scrollTop).toBe(scrollTop);
    const held = list.heldCorrection();

    // Momentum keeps scrolling after the finger lifts; scrollend marks its end.
    using _timers = fakeTimers();
    list.touch("touchend", [1], []);
    await advanceFrames();
    expect(list.scroller().scrollTop).toBe(scrollTop);

    list.scroller().dispatchEvent(new Event("scrollend"));
    await advanceFrames();

    expect(list.scroller().scrollTop).toBeCloseTo(scrollTop + held, 0);
    expect(list.contentNode().style.transform).toBe("");
    // The scroll offset snaps to whole device pixels, so the row may sit a fraction off.
    expect(list.rowTop("row-31")).toBeCloseTo(anchorTop, 0);
  });

  it("applies held corrections right away when the touch was a tap", async () => {
    await using list = await mountScrolledToRow(30);
    const scrollTop = list.scroller().scrollTop;

    list.touch("touchstart", [1], [1]);
    await list.growRow(28, ROW_HEIGHT + 120);
    await vi.waitFor(() => expect(list.heldCorrection()).toBeGreaterThanOrEqual(120));
    const held = list.heldCorrection();

    using _timers = fakeTimers();
    list.touch("touchend", [1], []);
    await advanceFrames();

    expect(list.scroller().scrollTop).toBeCloseTo(scrollTop + held, 0);
    expect(list.contentNode().style.transform).toBe("");
  });

  it("ends the hold when the scroller's finger lifts while a finger elsewhere stays down", async () => {
    await using list = await mountScrolledToRow(30);
    const scrollTop = list.scroller().scrollTop;

    // Finger 2 rests outside the scroller, so its events never reach it.
    list.touch("touchstart", [1], [1, 2]);
    await list.growRow(28, ROW_HEIGHT + 120);
    await vi.waitFor(() => expect(list.heldCorrection()).toBeGreaterThanOrEqual(120));
    const held = list.heldCorrection();

    using _timers = fakeTimers();
    list.touch("touchend", [1], [2]);
    await advanceFrames();

    expect(list.scroller().scrollTop).toBeCloseTo(scrollTop + held, 0);
    expect(list.contentNode().style.transform).toBe("");
  });

  it("holds corrections until every finger that started on the scroller lifts", async () => {
    await using list = await mountScrolledToRow(30);
    const scrollTop = list.scroller().scrollTop;

    list.touch("touchstart", [1], [1]);
    list.touch("touchstart", [2], [1, 2]);
    await list.growRow(28, ROW_HEIGHT + 120);
    await vi.waitFor(() => expect(list.heldCorrection()).toBeGreaterThanOrEqual(120));
    const held = list.heldCorrection();

    using _timers = fakeTimers();
    list.touch("touchend", [1], [2]);
    await advanceFrames();
    expect(list.scroller().scrollTop).toBe(scrollTop);
    expect(list.heldCorrection()).toBe(held);

    list.touch("touchend", [2], []);
    await advanceFrames();

    expect(list.scroller().scrollTop).toBeCloseTo(scrollTop + held, 0);
    expect(list.contentNode().style.transform).toBe("");
  });

  // A touch's later events go to the element it started on, even after that element
  // leaves the document, and from there they no longer bubble to the scroller.
  it("ends the hold when the element a finger started on is replaced before it lifts", async () => {
    await using list = await mountScrolledToRow(30);
    const scrollTop = list.scroller().scrollTop;
    const content = list.rowContent("row-31");

    list.touch("touchstart", [1], [1], content);
    await list.growRow(28, ROW_HEIGHT + 120);
    await vi.waitFor(() => expect(list.heldCorrection()).toBeGreaterThanOrEqual(120));
    const held = list.heldCorrection();
    await list.replaceRowContent(31);
    expect(content.isConnected).toBe(false);

    using _timers = fakeTimers();
    list.touch("touchend", [1], [], content);
    await advanceFrames();

    expect(list.scroller().scrollTop).toBeCloseTo(scrollTop + held, 0);
    expect(list.contentNode().style.transform).toBe("");
  });

  it("holds corrections until both fingers on a replaced element lift", async () => {
    await using list = await mountScrolledToRow(30);
    const scrollTop = list.scroller().scrollTop;
    const content = list.rowContent("row-31");

    list.touch("touchstart", [1], [1], content);
    list.touch("touchstart", [2], [1, 2], content);
    await list.growRow(28, ROW_HEIGHT + 120);
    await vi.waitFor(() => expect(list.heldCorrection()).toBeGreaterThanOrEqual(120));
    const held = list.heldCorrection();
    await list.replaceRowContent(31);
    expect(content.isConnected).toBe(false);

    using _timers = fakeTimers();
    list.touch("touchend", [1], [2], content);
    await advanceFrames();
    expect(list.scroller().scrollTop).toBe(scrollTop);
    expect(list.heldCorrection()).toBe(held);

    list.touch("touchend", [2], [], content);
    await advanceFrames();

    expect(list.scroller().scrollTop).toBeCloseTo(scrollTop + held, 0);
    expect(list.contentNode().style.transform).toBe("");
  });
});

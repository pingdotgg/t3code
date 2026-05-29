import { createRef, type Key, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  latestProps: null as MockLegendListProps | null,
}));

interface MockLegendListProps {
  readonly data?: readonly string[];
  readonly keyExtractor?: (item: string, index: number) => Key;
  readonly renderItem?: (args: { item: string; index: number }) => ReactNode;
  readonly ListHeaderComponent?: ReactNode;
  readonly ListFooterComponent?: ReactNode;
  readonly initialScrollAtEnd?: boolean;
  readonly maintainScrollAtEnd?: boolean | { animated?: boolean };
  readonly maintainScrollAtEndThreshold?: number;
  readonly maintainVisibleContentPosition?: unknown;
  readonly onScroll?: () => void;
  readonly onEndReached?: () => void;
  readonly onItemSizeChanged?: (info: MockItemSizeChange) => void;
  readonly estimatedItemSize?: number;
  readonly drawDistance?: number;
  readonly "data-testid"?: string;
}

interface MockItemSizeChange {
  readonly size?: unknown;
  readonly previous?: unknown;
  readonly index?: unknown;
  readonly itemKey?: unknown;
  readonly itemData?: unknown;
}

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: MockLegendListProps) => {
    mockState.latestProps = props;
    return (
      <div data-testid={props["data-testid"]}>
        {props.ListHeaderComponent}
        {props.data?.map((item, index) => {
          const key = props.keyExtractor?.(item, index) ?? index;
          return (
            <div data-key={String(key)} key={String(key)}>
              {props.renderItem?.({ item, index })}
            </div>
          );
        })}
        {props.ListFooterComponent}
      </div>
    );
  },
}));

import {
  VirtualizedList,
  type VirtualizedListHandle,
  createVirtualizedListHandle,
  resolveVirtualizedListDrawDistance,
} from "./VirtualizedList";

function getLatestLegendListProps(): MockLegendListProps {
  if (!mockState.latestProps) {
    throw new Error("LegendList was not rendered.");
  }
  return mockState.latestProps;
}

describe("VirtualizedList", () => {
  it("renders header, footer, and item content with stable keys", () => {
    const markup = renderToStaticMarkup(
      <VirtualizedList
        data={["alpha", "beta"]}
        keyExtractor={(item) => `item-${item}`}
        renderItem={({ item, index }) => `${index}:${item}`}
        ListHeaderComponent={<div>Header</div>}
        ListFooterComponent={<div>Footer</div>}
        data-testid="list"
      />,
    );

    expect(markup).toContain("Header");
    expect(markup).toContain("0:alpha");
    expect(markup).toContain("1:beta");
    expect(markup).toContain("Footer");
    expect(markup).toContain('data-key="item-alpha"');
    expect(markup).toContain('data-key="item-beta"');
  });

  it("passes initialScrollAtEnd through to LegendList", () => {
    renderToStaticMarkup(
      <VirtualizedList
        data={["alpha"]}
        keyExtractor={(item) => item}
        renderItem={({ item }) => item}
        initialScrollAtEnd
      />,
    );

    expect(getLatestLegendListProps().initialScrollAtEnd).toBe(true);
  });

  it("passes animated maintainScrollAtEnd through to LegendList", () => {
    renderToStaticMarkup(
      <VirtualizedList
        data={["alpha"]}
        keyExtractor={(item) => item}
        renderItem={({ item }) => item}
        maintainScrollAtEnd={{ animated: true }}
      />,
    );

    expect(getLatestLegendListProps().maintainScrollAtEnd).toEqual({ animated: true });
    expect(getLatestLegendListProps().maintainVisibleContentPosition).toEqual({
      data: false,
      size: true,
    });
  });

  it("allows maintainVisibleContentPosition to opt into data anchoring", () => {
    renderToStaticMarkup(
      <VirtualizedList
        data={["alpha"]}
        keyExtractor={(item) => item}
        renderItem={({ item }) => item}
        maintainVisibleContentPosition={{ data: true, size: true }}
      />,
    );

    expect(getLatestLegendListProps().maintainVisibleContentPosition).toEqual({
      data: true,
      size: true,
    });
  });

  it("updates at-end state through the imperative handle state source", () => {
    const onIsAtEndChange = vi.fn();
    renderToStaticMarkup(
      <VirtualizedList
        data={["alpha"]}
        keyExtractor={(item) => item}
        renderItem={({ item }) => item}
        onIsAtEndChange={onIsAtEndChange}
      />,
    );

    getLatestLegendListProps().onScroll?.();
    expect(onIsAtEndChange).not.toHaveBeenCalled();

    const isAtEndRef = { current: false };
    const handle = createVirtualizedListHandle({
      listRef: { current: null },
      isAtEndRef,
    });
    expect(handle.getState()).toEqual({ isAtEnd: false });
    isAtEndRef.current = true;
    expect(handle.getState()).toEqual({ isAtEnd: true });
  });

  it("maps imperative methods to LegendList scroll methods", async () => {
    const scrollToEnd = vi.fn();
    const scrollToOffset = vi.fn();
    const scrollIndexIntoView = vi.fn();
    const scrollableNode = {} as HTMLElement;
    const handle = createVirtualizedListHandle({
      listRef: {
        current: {
          getScrollableNode: () => scrollableNode,
          getState: () => ({ isAtEnd: true }) as ReturnType<VirtualizedListHandle["getState"]>,
          scrollToEnd,
          scrollToOffset,
          scrollIndexIntoView,
        },
      },
      isAtEndRef: { current: true },
    });

    expect(handle.getScrollableNode()).toBe(scrollableNode);

    await handle.scrollToEnd({ animated: false });
    await handle.scrollToEnd({ animated: true });
    await handle.scrollToOffset({ offset: 0, animated: false });
    await handle.scrollIndexIntoView({ index: 10, animated: false });

    expect(scrollToEnd).toHaveBeenNthCalledWith(1, { animated: false });
    expect(scrollToEnd).toHaveBeenNthCalledWith(2, { animated: true });
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
    expect(scrollIndexIntoView).toHaveBeenCalledWith({ index: 10, animated: false });
  });

  it("calls onEndReached when LegendList reports the end", () => {
    const onEndReached = vi.fn();
    renderToStaticMarkup(
      <VirtualizedList
        data={["alpha"]}
        keyExtractor={(item) => item}
        renderItem={({ item }) => item}
        onEndReached={onEndReached}
      />,
    );

    getLatestLegendListProps().onEndReached?.();
    expect(onEndReached).toHaveBeenCalledTimes(1);
  });

  it("forwards valid item size changes with normalized row data", () => {
    const onItemSizeChanged = vi.fn();
    renderToStaticMarkup(
      <VirtualizedList
        data={["alpha", "beta"]}
        keyExtractor={(item) => `item-${item}`}
        renderItem={({ item }) => item}
        onItemSizeChanged={onItemSizeChanged}
      />,
    );

    getLatestLegendListProps().onItemSizeChanged?.({
      index: 1,
      itemData: undefined,
      itemKey: "item-beta",
      previous: 90,
      size: 150,
    });

    expect(onItemSizeChanged).toHaveBeenCalledWith({
      index: 1,
      itemData: "beta",
      itemKey: "item-beta",
      previous: 90,
      size: 150,
    });
  });

  it("ignores item size changes without a valid index", () => {
    const onItemSizeChanged = vi.fn();
    renderToStaticMarkup(
      <VirtualizedList
        data={["alpha"]}
        keyExtractor={(item) => `item-${item}`}
        renderItem={({ item }) => item}
        onItemSizeChanged={onItemSizeChanged}
      />,
    );

    getLatestLegendListProps().onItemSizeChanged?.({
      itemKey: "item-alpha",
      previous: 90,
      size: 150,
    });

    expect(onItemSizeChanged).not.toHaveBeenCalled();
  });

  it("ignores item size changes for out-of-range indices", () => {
    const onItemSizeChanged = vi.fn();
    renderToStaticMarkup(
      <VirtualizedList
        data={["alpha"]}
        keyExtractor={(item) => `item-${item}`}
        renderItem={({ item }) => item}
        onItemSizeChanged={onItemSizeChanged}
      />,
    );

    getLatestLegendListProps().onItemSizeChanged?.({
      index: 1,
      itemKey: "item-alpha",
      previous: 90,
      size: 150,
    });

    expect(onItemSizeChanged).not.toHaveBeenCalled();
  });

  it("ignores item size changes with stale item keys", () => {
    const onItemSizeChanged = vi.fn();
    renderToStaticMarkup(
      <VirtualizedList
        data={["alpha"]}
        keyExtractor={(item) => `item-${item}`}
        renderItem={({ item }) => item}
        onItemSizeChanged={onItemSizeChanged}
      />,
    );

    getLatestLegendListProps().onItemSizeChanged?.({
      index: 0,
      itemKey: "item-beta",
      previous: 90,
      size: 150,
    });

    expect(onItemSizeChanged).not.toHaveBeenCalled();
  });

  it("ignores item size changes with non-finite sizes", () => {
    const onItemSizeChanged = vi.fn();
    renderToStaticMarkup(
      <VirtualizedList
        data={["alpha"]}
        keyExtractor={(item) => `item-${item}`}
        renderItem={({ item }) => item}
        onItemSizeChanged={onItemSizeChanged}
      />,
    );

    getLatestLegendListProps().onItemSizeChanged?.({
      index: 0,
      itemKey: "item-alpha",
      previous: Number.NaN,
      size: 150,
    });
    getLatestLegendListProps().onItemSizeChanged?.({
      index: 0,
      itemKey: "item-alpha",
      previous: 90,
      size: Number.POSITIVE_INFINITY,
    });

    expect(onItemSizeChanged).not.toHaveBeenCalled();
  });

  it("maps overscan props to LegendList drawDistance", () => {
    renderToStaticMarkup(
      <VirtualizedList
        data={["alpha"]}
        keyExtractor={(item) => item}
        renderItem={({ item }) => item}
        estimatedItemSize={28}
        increaseViewportBy={{ top: 100, bottom: 336 }}
        minOverscanItemCount={{ top: 2, bottom: 4 }}
      />,
    );

    expect(getLatestLegendListProps().drawDistance).toBe(336);
    expect(
      resolveVirtualizedListDrawDistance({
        estimatedItemSize: 28,
        increaseViewportBy: undefined,
        minOverscanItemCount: 4,
      }),
    ).toBe(112);
  });

  it("accepts refs with the public handle type", () => {
    const ref = createRef<VirtualizedListHandle | null>();

    renderToStaticMarkup(
      <VirtualizedList
        ref={ref}
        data={["alpha"]}
        keyExtractor={(item) => item}
        renderItem={({ item }) => item}
      />,
    );

    expect(ref.current).toBeNull();
  });
});

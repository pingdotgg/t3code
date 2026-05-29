import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type ForwardedRef,
  type Key,
  type ReactElement,
  type ReactNode,
  type RefAttributes,
} from "react";
import {
  LegendList,
  type LegendListRef,
  type MaintainVisibleContentPositionConfig,
} from "@legendapp/list/react";

type RefBox<T> = { current: T };
type VirtualizedListImperativeTarget = {
  getScrollableNode(): HTMLElement | null;
  getState(): VirtualizedListState;
  scrollToEnd(options?: { animated?: boolean }): Promise<void> | void;
  scrollToOffset(options: { offset: number; animated?: boolean }): Promise<void> | void;
  scrollIndexIntoView(options: { index: number; animated?: boolean }): Promise<void> | void;
};

interface VirtualizedListDrawDistanceInput {
  readonly estimatedItemSize: number | undefined;
  readonly increaseViewportBy: number | { top: number; bottom: number } | undefined;
  readonly minOverscanItemCount: number | { top: number; bottom: number } | undefined;
}

const DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  data: false,
  size: true,
} as const satisfies MaintainVisibleContentPositionConfig;

export interface VirtualizedListState {
  readonly isAtEnd: boolean;
}

export interface VirtualizedListHandle {
  getScrollableNode(): HTMLElement | null;
  getState(): VirtualizedListState;
  scrollToEnd(options?: { animated?: boolean }): Promise<void>;
  scrollToOffset(options: { offset: number; animated?: boolean }): Promise<void>;
  scrollIndexIntoView(options: { index: number; animated?: boolean }): Promise<void>;
}

export interface VirtualizedListItemSizeChange<T> {
  readonly size: number;
  readonly previous: number;
  readonly index: number;
  readonly itemKey: string;
  readonly itemData: T;
}

interface RawVirtualizedListItemSizeChange {
  readonly size?: unknown;
  readonly previous?: unknown;
  readonly index?: unknown;
  readonly itemKey?: unknown;
}

export interface VirtualizedListProps<T> {
  readonly data: readonly T[];
  readonly keyExtractor: (item: T, index: number) => Key;
  readonly getItemType?: (item: T, index: number) => string | undefined;
  readonly renderItem: (args: { item: T; index: number }) => ReactNode;
  readonly estimatedItemSize?: number;
  readonly initialScrollAtEnd?: boolean;
  readonly maintainScrollAtEnd?: boolean | { animated?: boolean };
  readonly maintainScrollAtEndThreshold?: number;
  readonly maintainVisibleContentPosition?: boolean | MaintainVisibleContentPositionConfig<T>;
  readonly onIsAtEndChange?: (isAtEnd: boolean) => void;
  readonly onEndReached?: () => void;
  readonly onItemSizeChanged?: (info: VirtualizedListItemSizeChange<T>) => void;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly ListHeaderComponent?: ReactNode;
  readonly ListFooterComponent?: ReactNode;
  readonly increaseViewportBy?: number | { top: number; bottom: number };
  readonly minOverscanItemCount?: number | { top: number; bottom: number };
  readonly "data-testid"?: string;
}

export function resolveVirtualizedListDrawDistance({
  estimatedItemSize,
  increaseViewportBy,
  minOverscanItemCount,
}: VirtualizedListDrawDistanceInput): number | undefined {
  const viewportDistance = resolveMaxOverscanValue(increaseViewportBy);
  const overscanItemCount = resolveMaxOverscanValue(minOverscanItemCount);
  const itemDistance =
    overscanItemCount !== undefined && estimatedItemSize !== undefined
      ? overscanItemCount * estimatedItemSize
      : undefined;
  if (viewportDistance === undefined) {
    return itemDistance;
  }
  if (itemDistance === undefined) {
    return viewportDistance;
  }
  return Math.max(viewportDistance, itemDistance);
}

export function createVirtualizedListHandle({
  listRef,
  isAtEndRef,
}: {
  readonly listRef: RefBox<VirtualizedListImperativeTarget | null>;
  readonly isAtEndRef: RefBox<boolean>;
}): VirtualizedListHandle {
  return {
    getScrollableNode: () => listRef.current?.getScrollableNode?.() ?? null,
    getState: () => ({
      isAtEnd: listRef.current?.getState?.().isAtEnd ?? isAtEndRef.current,
    }),
    scrollToEnd: (options) => {
      const scrollOptions =
        options?.animated === undefined ? undefined : { animated: options.animated };
      return Promise.resolve(listRef.current?.scrollToEnd?.(scrollOptions));
    },
    scrollToOffset: ({ offset, animated }) => {
      const scrollOptions = animated === undefined ? { offset } : { offset, animated };
      return Promise.resolve(listRef.current?.scrollToOffset?.(scrollOptions));
    },
    scrollIndexIntoView: ({ index, animated }) => {
      const scrollOptions = animated === undefined ? { index } : { index, animated };
      return Promise.resolve(listRef.current?.scrollIndexIntoView?.(scrollOptions));
    },
  };
}

function resolveMaxOverscanValue(
  value: number | { top: number; bottom: number } | undefined,
): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (!value) {
    return undefined;
  }
  return Math.max(value.top, value.bottom);
}

function VirtualizedListInner<T>(
  {
    data,
    keyExtractor,
    getItemType,
    renderItem,
    estimatedItemSize,
    initialScrollAtEnd = false,
    maintainScrollAtEnd = false,
    maintainScrollAtEndThreshold,
    maintainVisibleContentPosition = DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION,
    onIsAtEndChange,
    onEndReached,
    onItemSizeChanged,
    className,
    style,
    ListHeaderComponent,
    ListFooterComponent,
    increaseViewportBy,
    minOverscanItemCount,
    "data-testid": dataTestId,
  }: VirtualizedListProps<T>,
  ref: ForwardedRef<VirtualizedListHandle>,
) {
  const listRef = useRef<LegendListRef | null>(null);
  const isAtEndRef = useRef(initialScrollAtEnd || data.length === 0);

  const handleScroll = useCallback(() => {
    const nextIsAtEnd = listRef.current?.getState?.().isAtEnd ?? isAtEndRef.current;
    if (nextIsAtEnd !== isAtEndRef.current) {
      onIsAtEndChange?.(nextIsAtEnd);
    }
    isAtEndRef.current = nextIsAtEnd;
  }, [onIsAtEndChange]);

  const handleKeyExtractor = useCallback(
    (item: T, index: number) => String(keyExtractor(item, index)),
    [keyExtractor],
  );

  const handleGetItemType = useCallback(
    (item: T, index: number) => getItemType?.(item, index),
    [getItemType],
  );

  const handleRenderItem = useCallback(
    ({ item, index }: { item: T; index: number }) => renderItem({ item, index }),
    [renderItem],
  );

  const handleItemSizeChanged = useCallback(
    (info: RawVirtualizedListItemSizeChange) => {
      if (!onItemSizeChanged) {
        return;
      }
      if (typeof info.index !== "number" || !Number.isInteger(info.index)) {
        return;
      }
      if (typeof info.size !== "number" || !Number.isFinite(info.size)) {
        return;
      }
      if (typeof info.previous !== "number" || !Number.isFinite(info.previous)) {
        return;
      }
      if (typeof info.itemKey !== "string") {
        return;
      }

      const index = info.index;
      const itemData = data[index];
      if (itemData === undefined) {
        return;
      }

      const itemKey = handleKeyExtractor(itemData, index);
      if (itemKey !== info.itemKey) {
        return;
      }

      onItemSizeChanged({
        index,
        itemData,
        itemKey,
        previous: info.previous,
        size: info.size,
      });
    },
    [data, handleKeyExtractor, onItemSizeChanged],
  );

  useImperativeHandle(
    ref,
    () =>
      createVirtualizedListHandle({
        listRef,
        isAtEndRef,
      }),
    [],
  );

  const drawDistance = resolveVirtualizedListDrawDistance({
    estimatedItemSize,
    increaseViewportBy,
    minOverscanItemCount,
  });

  return (
    <LegendList<T>
      ref={listRef}
      data={data}
      keyExtractor={handleKeyExtractor}
      {...(getItemType ? { getItemType: handleGetItemType } : {})}
      renderItem={handleRenderItem}
      initialScrollAtEnd={initialScrollAtEnd}
      maintainScrollAtEnd={maintainScrollAtEnd}
      maintainVisibleContentPosition={maintainVisibleContentPosition}
      onScroll={handleScroll}
      ListHeaderComponent={ListHeaderComponent ? <>{ListHeaderComponent}</> : null}
      ListFooterComponent={ListFooterComponent ? <>{ListFooterComponent}</> : null}
      {...(className !== undefined ? { className } : {})}
      {...(style !== undefined ? { style } : {})}
      {...(onEndReached ? { onEndReached: () => onEndReached() } : {})}
      {...(onItemSizeChanged ? { onItemSizeChanged: handleItemSizeChanged } : {})}
      {...(dataTestId !== undefined ? { "data-testid": dataTestId } : {})}
      {...(estimatedItemSize !== undefined ? { estimatedItemSize } : {})}
      {...(maintainScrollAtEndThreshold !== undefined ? { maintainScrollAtEndThreshold } : {})}
      {...(drawDistance !== undefined ? { drawDistance } : {})}
    />
  );
}

export const VirtualizedList = forwardRef(VirtualizedListInner) as <T>(
  props: VirtualizedListProps<T> & RefAttributes<VirtualizedListHandle>,
) => ReactElement;

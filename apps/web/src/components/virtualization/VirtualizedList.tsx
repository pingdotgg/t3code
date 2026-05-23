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
import { LegendList, type LegendListRef } from "@legendapp/list/react";

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

export interface VirtualizedListState {
  readonly isAtEnd: boolean;
}

export interface VirtualizedListHandle {
  getScrollableNode(): HTMLElement | null;
  getState(): VirtualizedListState;
  scrollToEnd(options?: { animated?: boolean }): void;
  scrollToOffset(options: { offset: number; animated?: boolean }): void;
  scrollIndexIntoView(options: { index: number; animated?: boolean }): void;
}

export interface VirtualizedListProps<T> {
  readonly data: readonly T[];
  readonly keyExtractor: (item: T, index: number) => Key;
  readonly renderItem: (args: { item: T; index: number }) => ReactNode;
  readonly estimatedItemSize?: number;
  readonly initialScrollAtEnd?: boolean;
  readonly maintainScrollAtEnd?: boolean | { animated?: boolean };
  readonly maintainScrollAtEndThreshold?: number;
  readonly onIsAtEndChange?: (isAtEnd: boolean) => void;
  readonly onEndReached?: () => void;
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
      void listRef.current?.scrollToEnd?.(scrollOptions);
    },
    scrollToOffset: ({ offset, animated }) => {
      const scrollOptions = animated === undefined ? { offset } : { offset, animated };
      void listRef.current?.scrollToOffset?.(scrollOptions);
    },
    scrollIndexIntoView: ({ index, animated }) => {
      const scrollOptions = animated === undefined ? { index } : { index, animated };
      void listRef.current?.scrollIndexIntoView?.(scrollOptions);
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
    renderItem,
    estimatedItemSize,
    initialScrollAtEnd = false,
    maintainScrollAtEnd = false,
    maintainScrollAtEndThreshold,
    onIsAtEndChange,
    onEndReached,
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

  const handleRenderItem = useCallback(
    ({ item, index }: { item: T; index: number }) => renderItem({ item, index }),
    [renderItem],
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
      renderItem={handleRenderItem}
      initialScrollAtEnd={initialScrollAtEnd}
      maintainScrollAtEnd={maintainScrollAtEnd}
      maintainVisibleContentPosition={{ data: false, size: true }}
      onScroll={handleScroll}
      ListHeaderComponent={ListHeaderComponent ? <>{ListHeaderComponent}</> : null}
      ListFooterComponent={ListFooterComponent ? <>{ListFooterComponent}</> : null}
      {...(className !== undefined ? { className } : {})}
      {...(style !== undefined ? { style } : {})}
      {...(onEndReached ? { onEndReached: () => onEndReached() } : {})}
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

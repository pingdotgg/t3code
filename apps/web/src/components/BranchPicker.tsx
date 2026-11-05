import type { VcsRef } from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useRef, useState, type ComponentProps, type ReactNode } from "react";

import { MiddleTruncate } from "./ui/middle-truncate";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";
import { shouldLoadNextBranchPageAfterScroll } from "../state/paginatedBranches";
import { getVirtualizedScrollFadeClassName } from "./ui/scroll-area";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxStatus,
} from "./ui/combobox";

export function BranchPicker({
  items,
  filteredItems,
  value,
  query,
  onQueryChange,
  open,
  onOpenChange,
  onSelectItem,
  hasNextPage,
  isFetchingNextPage,
  onLoadNext,
  statusText,
  popupProps,
  renderItem,
  getItemType,
  children,
}: {
  items: string[];
  filteredItems: string[];
  value: string | null;
  query: string;
  onQueryChange: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectItem: (value: string) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadNext: () => void;
  statusText: string | null;
  popupProps: Omit<ComponentProps<typeof ComboboxPopup>, "children">;
  renderItem: (value: string, index: number) => ReactNode;
  getItemType?: ((value: string) => string) | undefined;
  children: ReactNode;
}) {
  const highlightedValueRef = useRef<string | null>(null);
  const branchListScrollElementRef = useRef<HTMLElement | null>(null);
  const previousBranchListScrollTopRef = useRef<number | null>(null);
  const handleOpenChange = (nextOpen: boolean) => {
    previousBranchListScrollTopRef.current = null;
    if (!nextOpen) highlightedValueRef.current = null;
    onOpenChange(nextOpen);
  };
  const [showTopBranchScrollFade, setShowTopBranchScrollFade] = useState(false);
  const [showBottomBranchScrollFade, setShowBottomBranchScrollFade] = useState(false);
  const fetchNextBranchPage = () => {
    if (!hasNextPage || isFetchingNextPage) {
      return;
    }

    onLoadNext();
  };
  const maybeFetchNextBranchPage = () => {
    const scrollElement = branchListScrollElementRef.current;
    if (!scrollElement) {
      return;
    }

    const previousScrollTop = previousBranchListScrollTopRef.current;
    previousBranchListScrollTopRef.current = scrollElement.scrollTop;
    if (
      !open ||
      !hasNextPage ||
      isFetchingNextPage ||
      !shouldLoadNextBranchPageAfterScroll({
        previousScrollTop,
        scrollTop: scrollElement.scrollTop,
        scrollHeight: scrollElement.scrollHeight,
        clientHeight: scrollElement.clientHeight,
      })
    ) {
      return;
    }

    fetchNextBranchPage();
  };

  const branchListRef = useRef<LegendListRef | null>(null);
  const updateBranchListScrollFades = () => {
    const scrollElement = branchListRef.current?.getScrollableNode?.();
    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }
    branchListScrollElementRef.current = scrollElement;
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopBranchScrollFade(scrollElement.scrollTop > 1);
    setShowBottomBranchScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  };

  // The popup mounts the list when it opens. Its content settles over a few
  // frames as rows measure, so the fades follow the scroller and its content.
  const attachBranchList = (list: LegendListRef | null) => {
    branchListRef.current = list;
    const scrollElement = list?.getScrollableNode?.();
    if (!(scrollElement instanceof HTMLElement)) return;
    const content = scrollElement.firstElementChild;
    const stopObserving = observeResize(
      content ? [scrollElement, content] : scrollElement,
      updateBranchListScrollFades,
    );
    return () => {
      stopObserving();
      branchListRef.current = null;
    };
  };

  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      autoHighlight
      virtualized
      onItemHighlighted={(value, eventDetails) => {
        highlightedValueRef.current = typeof value === "string" ? value : null;
        if (!open || eventDetails.index < 0 || eventDetails.reason !== "keyboard") {
          return;
        }
        void branchListRef.current?.scrollIndexIntoView?.({
          index: eventDetails.index,
          animated: false,
        });
      }}
      onOpenChange={handleOpenChange}
      open={open}
      value={value}
    >
      {children}
      <ComboboxPopup {...popupProps}>
        <ComboboxSearchInput
          placeholder="Search refs..."
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            void branchListRef.current?.scrollToOffset?.({ offset: 0, animated: false });
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229)
              return;
            const highlightedValue = highlightedValueRef.current;
            if (highlightedValue === null || !filteredItems.includes(highlightedValue)) return;
            (
              event as typeof event & { preventBaseUIHandler?: () => void }
            ).preventBaseUIHandler?.();
            event.preventDefault();
            event.stopPropagation();
            highlightedValueRef.current = null;
            onSelectItem(highlightedValue);
          }}
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ComboboxEmpty>No refs found.</ComboboxEmpty>
          <div className="relative flex min-h-0 w-full max-h-56 flex-1 flex-col overflow-hidden">
            <ComboboxListVirtualized className="flex size-full min-h-0 min-w-0 flex-col">
              <LegendList<string>
                ref={attachBranchList}
                data={filteredItems}
                keyExtractor={(item) => item}
                {...(getItemType ? { getItemType } : {})}
                renderItem={({ item, index }) => renderItem(item, index)}
                estimatedItemSize={28}
                drawDistance={336}
                onLayout={() => {
                  updateBranchListScrollFades();
                  previousBranchListScrollTopRef.current =
                    branchListScrollElementRef.current?.scrollTop ?? null;
                }}
                onScroll={() => {
                  updateBranchListScrollFades();
                  maybeFetchNextBranchPage();
                }}
                className={cn(
                  "min-h-0 max-h-56 scrollbar-gutter-stable overflow-x-hidden overscroll-y-contain ps-1 pe-0 py-2",
                  getVirtualizedScrollFadeClassName({
                    top: showTopBranchScrollFade,
                    bottom: showBottomBranchScrollFade,
                  }),
                )}
              />
            </ComboboxListVirtualized>
          </div>
          {statusText ? <ComboboxStatus>{statusText}</ComboboxStatus> : null}
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}

export function BranchPickerRefItem({
  branch: refName,
  index,
  value,
  disabled,
  onClick,
  onContextMenu,
}: {
  branch: VcsRef;
  index: number;
  value?: string;
  disabled?: boolean;
  onClick: ComponentProps<typeof ComboboxItem>["onClick"];
  onContextMenu?: ComponentProps<typeof ComboboxItem>["onContextMenu"];
}) {
  const itemValue = refName.name;
  const badge = refName.current
    ? "current"
    : refName.isRemote
      ? "remote"
      : refName.isDefault
        ? "default"
        : null;
  return (
    <ComboboxItem
      disabled={disabled}
      hideIndicator
      key={itemValue}
      index={index}
      value={value ?? itemValue}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="flex w-full min-w-0 items-center justify-between gap-2">
        <MiddleTruncate value={itemValue} className="flex-1" />
        {badge && <span className="shrink-0 text-3xs text-muted-foreground/45">{badge}</span>}
      </div>
    </ComboboxItem>
  );
}

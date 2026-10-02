import type { VcsRef } from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { MiddleTruncate } from "./ui/middle-truncate";
import { cn } from "../lib/utils";
import { shouldLoadNextBranchPageAfterScroll } from "../state/paginatedBranches";
import { RefreshIcon } from "./ui/refresh-icon";
import { Switch } from "./ui/switch";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Shared composer picker UI. The caller owns selection and any checkout mutations. */
export function BranchPicker({
  items,
  filteredItems,
  value,
  query,
  resultsQuery,
  onQueryChange,
  open,
  onOpenChange,
  onSelectItem,
  hasNextPage,
  isFetchingNextPage,
  onLoadNext,
  statusText,
  originControl,
  popupProps,
  renderItem,
  getItemType,
  children,
}: {
  items: string[];
  filteredItems: string[];
  value: string | null;
  query: string;
  resultsQuery: string;
  onQueryChange: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectItem: (value: string) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadNext: () => void;
  statusText: string | null;
  originControl?: { checked: boolean; onCheckedChange: (checked: boolean) => void } | undefined;
  popupProps: Omit<ComponentProps<typeof ComboboxPopup>, "children">;
  renderItem: (value: string, index: number) => ReactNode;
  getItemType?: ((value: string) => string) | undefined;
  children: ReactNode;
}) {
  const highlightedValueRef = useRef<string | null>(null);
  const startFromOriginSwitchId = useId();
  const branchListScrollElementRef = useRef<HTMLElement | null>(null);
  const previousBranchListScrollTopRef = useRef<number | null>(null);
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      previousBranchListScrollTopRef.current = null;
      if (!nextOpen) highlightedValueRef.current = null;
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );
  const [showTopBranchScrollFade, setShowTopBranchScrollFade] = useState(false);
  const [showBottomBranchScrollFade, setShowBottomBranchScrollFade] = useState(false);
  const fetchNextBranchPage = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage) {
      return;
    }

    onLoadNext();
  }, [onLoadNext, hasNextPage, isFetchingNextPage]);
  const maybeFetchNextBranchPage = useCallback(() => {
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
  }, [fetchNextBranchPage, hasNextPage, open, isFetchingNextPage]);

  const branchListRef = useRef<LegendListRef | null>(null);
  const updateBranchListScrollFades = useCallback(() => {
    const scrollElement = branchListRef.current?.getScrollableNode?.();
    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }
    branchListScrollElementRef.current = scrollElement;
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopBranchScrollFade(scrollElement.scrollTop > 1);
    setShowBottomBranchScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    let nestedFrame = 0;
    const frame = requestAnimationFrame(() => {
      updateBranchListScrollFades();
      nestedFrame = requestAnimationFrame(updateBranchListScrollFades);
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nestedFrame);
    };
  }, [open, updateBranchListScrollFades]);

  const previousResultsQuery = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      previousResultsQuery.current = null;
      return;
    }
    if (previousResultsQuery.current === resultsQuery) return;
    previousResultsQuery.current = resultsQuery;
    void branchListRef.current?.scrollToOffset?.({ offset: 0, animated: false });
  }, [resultsQuery, open]);

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
          onChange={(event) => onQueryChange(event.target.value)}
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
          <div className="relative min-h-0 w-full max-h-56 flex-1 overflow-hidden">
            <ComboboxListVirtualized className="size-full min-w-0">
              <LegendList<string>
                ref={branchListRef}
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
                  "max-h-56 scrollbar-gutter-stable overflow-x-hidden overscroll-y-contain ps-1 pe-0 pt-2 pb-1",
                  getVirtualizedScrollFadeClassName({
                    top: showTopBranchScrollFade,
                    bottom: showBottomBranchScrollFade,
                  }),
                )}
              />
            </ComboboxListVirtualized>
          </div>
          {originControl ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <label
                    htmlFor={startFromOriginSwitchId}
                    className="flex cursor-pointer items-center justify-between gap-3 border-t border-border/60 px-3 py-2 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 font-medium text-muted-foreground">
                      <RefreshIcon aria-hidden="true" className="size-3 shrink-0" />
                      <span className="truncate">Start from origin</span>
                    </span>
                    <Switch
                      id={startFromOriginSwitchId}
                      checked={originControl.checked}
                      size="sm"
                      aria-label="Start worktree from origin"
                      onCheckedChange={(checked) => originControl.onCheckedChange(Boolean(checked))}
                    />
                  </label>
                }
              />
              <TooltipPopup side="top" className="max-w-72 whitespace-normal">
                Creates the worktree from the latest matching branch on origin instead of your local
                branch.
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {statusText ? <ComboboxStatus>{statusText}</ComboboxStatus> : null}
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}

export function BranchPickerRefItem({
  branch: refName,
  projectCwd: activeProjectCwd,
  index,
  value,
  onClick,
  onContextMenu,
}: {
  branch: VcsRef;
  projectCwd: string | null;
  index: number;
  value?: string;
  onClick: ComponentProps<typeof ComboboxItem>["onClick"];
  onContextMenu?: ComponentProps<typeof ComboboxItem>["onContextMenu"];
}) {
  const itemValue = refName.name;
  const hasSecondaryWorktree =
    refName.worktreePath && activeProjectCwd && refName.worktreePath !== activeProjectCwd;
  const badge = refName.current
    ? "current"
    : hasSecondaryWorktree
      ? "worktree"
      : refName.isRemote
        ? "remote"
        : refName.isDefault
          ? "default"
          : null;
  return (
    <ComboboxItem
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

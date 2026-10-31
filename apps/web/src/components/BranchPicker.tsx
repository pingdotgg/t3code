import type { VcsRef } from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useId, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { CheckIcon, CloudIcon, GitBranchIcon } from "lucide-react";

import { useRelativeTimeState } from "../hooks/useRelativeTimeState";
import { Badge } from "./ui/badge";
import { MiddleTruncate } from "./ui/middle-truncate";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";
import { shouldLoadNextBranchPageAfterScroll } from "../state/paginatedBranches";
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

function BranchPickerSeparator() {
  return <div className="h-px" />;
}

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
  originControl,
  popupProps,
  renderItem,
  getItemType,
  getItemGroup,
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
  originControl?: { checked: boolean; onCheckedChange: (checked: boolean) => void } | undefined;
  popupProps: Omit<ComponentProps<typeof ComboboxPopup>, "children">;
  renderItem: (value: string, index: number) => ReactNode;
  getItemType?: ((value: string) => string) | undefined;
  getItemGroup?: ((value: string) => string) | undefined;
  children: ReactNode;
}) {
  const highlightedValueRef = useRef<string | null>(null);
  const startFromOriginSwitchId = useId();
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
      <ComboboxPopup spacing="relaxed" {...popupProps}>
        <ComboboxSearchInput
          variant="inset"
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
                renderItem={({ item, index }) => {
                  const group = getItemGroup?.(item);
                  const previous = index > 0 ? getItemGroup?.(filteredItems[index - 1]!) : null;
                  return (
                    <>
                      {group && group !== previous ? (
                        <div className="px-2.5 pt-2 pb-1 text-caption text-dim-foreground">
                          {group}
                        </div>
                      ) : null}
                      {renderItem(item, index)}
                    </>
                  );
                }}
                ItemSeparatorComponent={BranchPickerSeparator}
                estimatedItemSize={33}
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
                  "min-h-0 max-h-56 scrollbar-gutter-stable overflow-x-hidden overscroll-y-contain px-0.5 pb-0.5",
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
                    className="mx-1.5 mb-1.5 flex cursor-pointer items-center gap-2 border-t border-divider px-2.5 pt-2 pb-1 text-meta"
                  >
                    <Switch
                      id={startFromOriginSwitchId}
                      checked={originControl.checked}
                      size="sm"
                      aria-label="Start worktree from remote"
                      onCheckedChange={(checked) => originControl.onCheckedChange(Boolean(checked))}
                    />
                    <span className="min-w-0 flex-1 truncate">Start from remote</span>
                    <span className="text-caption text-dim-foreground">fetches first</span>
                  </label>
                }
              />
              <TooltipPopup side="top" className="max-w-72 whitespace-normal">
                Uses the latest commit of the base branch’s tracked remote branch, even if its name
                differs. Otherwise uses the same-named branch on origin. Uses your local branch if
                that remote branch is missing.
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {statusText ? <ComboboxStatus>{statusText}</ComboboxStatus> : null}
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}

/** A section label ("Local", "Remote", "Pull requests") drawn above a group's first row. */
export function BranchPickerGroupLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 text-meta text-dim-foreground">{children}</div>;
}

export function BranchPickerRefItem({
  branch: refName,
  projectCwd: activeProjectCwd,
  index,
  value,
  selected = false,
  groupLabel = null,
  disabled,
  onClick,
  onContextMenu,
}: {
  branch: VcsRef;
  projectCwd: string | null;
  index: number;
  value?: string;
  /** The ref the thread is on, marked with a check. */
  selected?: boolean;
  /** Set on the first row of a group to draw its section label above it. */
  groupLabel?: string | null;
  disabled?: boolean;
  onClick: ComponentProps<typeof ComboboxItem>["onClick"];
  onContextMenu?: ComponentProps<typeof ComboboxItem>["onContextMenu"];
}) {
  const itemValue = refName.name;
  const hasSecondaryWorktree =
    refName.worktreePath && activeProjectCwd && refName.worktreePath !== activeProjectCwd;
  const badge = refName.current ? "current" : hasSecondaryWorktree ? "worktree" : null;
  const relative = useRelativeTimeState(
    refName.lastCommitAt === undefined ? null : new Date(refName.lastCommitAt * 1000).toISOString(),
  );
  const age =
    relative.status === "relative" ? (relative.suffix === null ? "now" : relative.value) : null;
  const RefIcon = refName.isRemote ? CloudIcon : GitBranchIcon;
  return (
    <div>
      {groupLabel ? <BranchPickerGroupLabel>{groupLabel}</BranchPickerGroupLabel> : null}
      <ComboboxItem
        disabled={disabled}
        hideIndicator
        key={itemValue}
        index={index}
        value={value ?? itemValue}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <div className="flex w-full min-w-0 items-center gap-2">
          <RefIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <MiddleTruncate value={itemValue} className="flex-1" />
          {badge ? <span className="shrink-0 text-micro text-dim-foreground">{badge}</span> : null}
          {refName.isDefault ? <Badge variant="secondary">default</Badge> : null}
          {selected ? (
            <CheckIcon aria-hidden className="size-3.5 shrink-0 text-foreground" />
          ) : age ? (
            <span className="shrink-0 text-meta text-dim-foreground tabular-nums">{age}</span>
          ) : null}
        </div>
      </ComboboxItem>
    </div>
  );
}

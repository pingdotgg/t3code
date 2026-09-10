import { ChevronDownIcon, SearchIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";

import { cn } from "~/lib/utils";

import { RefreshIcon } from "../ui/refresh-icon";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ListFilterOption } from "./ListFilterMenu";

export function ListRefreshControl({
  label,
  compact = false,
  refreshing,
  onRefresh,
}: {
  label: string;
  compact?: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <Button
      size={compact ? "icon-sm" : "icon"}
      variant={compact ? "ghost" : "outline"}
      aria-label={label}
      onClick={onRefresh}
      disabled={refreshing}
    >
      <RefreshIcon className="size-4" refreshing={refreshing} />
    </Button>
  );
}

/** A compact stand-in for one pill group when the header is narrow. */
export function CompactFilterMenu<Value extends string>({
  label,
  triggerIcon,
  triggerLabel,
  outlined = false,
  value,
  options,
  onChange,
  className,
  children,
}: {
  label: string;
  triggerIcon?: ReactNode;
  triggerLabel?: string;
  outlined?: boolean;
  value: Value;
  options: ReadonlyArray<ListFilterOption<Value>>;
  onChange: (value: Value) => void;
  className?: string;
  children?: ReactNode;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <Menu>
      <MenuTrigger
        aria-label={triggerLabel ? `${label}: ${current.label}` : label}
        render={outlined ? <Button variant="outline" /> : undefined}
        className={
          outlined
            ? className
            : cn(
                "inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
                className,
              )
        }
      >
        {triggerLabel ? (
          <>
            {triggerIcon}
            <span>{triggerLabel}</span>
          </>
        ) : (
          <>
            {outlined ? <current.Icon aria-hidden className="size-4 shrink-0" /> : null}
            <span className="truncate">{current.label}</span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="min-w-40">
        {children ?? (
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (next !== value) onChange(next as Value);
            }}
          >
            {options.map((option) => {
              const item = (
                <MenuRadioItem
                  key={option.value}
                  value={option.value}
                  disabled={option.unavailable !== undefined}
                  className="data-disabled:pointer-events-auto"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <option.Icon aria-hidden className="size-3.5" />
                    {option.label}
                  </span>
                </MenuRadioItem>
              );
              return option.unavailable === undefined ? (
                item
              ) : (
                <Tooltip key={option.value}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="right" className="max-w-64 break-words">
                    {option.unavailable}
                  </TooltipPopup>
                </Tooltip>
              );
            })}
          </MenuRadioGroup>
        )}
      </MenuPopup>
    </Menu>
  );
}

export function ExpandableSearch({
  label,
  searchInput,
  searchValue,
  open,
  onOpenChange,
  focusToken,
  onFocusWithin,
}: {
  label: string;
  searchInput: ReactNode;
  searchValue: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  focusToken: number;
  onFocusWithin?: (focused: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) containerRef.current?.querySelector("input")?.focus();
  }, [open]);
  const appliedFocusToken = useRef(focusToken);
  useEffect(() => {
    if (appliedFocusToken.current === focusToken) return;
    appliedFocusToken.current = focusToken;
    const input = containerRef.current?.querySelector("input");
    input?.focus();
    input?.select();
  }, [focusToken]);
  if (open || searchValue.length > 0) {
    return (
      <div
        ref={containerRef}
        className="w-56 min-w-24 shrink"
        onFocus={() => onFocusWithin?.(true)}
        onBlur={() => {
          onFocusWithin?.(false);
          if (searchValue.length === 0) onOpenChange(false);
        }}
      >
        {searchInput}
      </div>
    );
  }
  return (
    <Button size="icon-sm" variant="ghost" aria-label={label} onClick={() => onOpenChange(true)}>
      <SearchIcon className="size-4" />
    </Button>
  );
}

export function useListSearchShortcut({
  active,
  condensed,
  inFlowSearchRef,
  setSearchOpen,
  setSearchFocusToken,
}: {
  active: boolean;
  condensed: boolean;
  inFlowSearchRef: RefObject<HTMLDivElement | null>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setSearchFocusToken: Dispatch<SetStateAction<number>>;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active || event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      if (
        event.target instanceof HTMLElement &&
        !inFlowSearchRef.current?.contains(event.target) &&
        (event.target.isContentEditable || event.target.closest("input, textarea, select"))
      ) {
        return;
      }
      event.preventDefault();
      if (condensed) {
        setSearchOpen(true);
        setSearchFocusToken((token) => token + 1);
        return;
      }
      const input = inFlowSearchRef.current?.querySelector("input");
      input?.focus();
      input?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, condensed, inFlowSearchRef, setSearchFocusToken, setSearchOpen]);
}

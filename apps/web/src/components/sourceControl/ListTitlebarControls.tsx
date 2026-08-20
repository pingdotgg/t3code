import { ChevronDownIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";

import { cn } from "~/lib/utils";

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
      <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
    </Button>
  );
}

export function CompactFilterMenu<Value extends string>({
  label,
  value,
  options,
  onChange,
  children,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<ListFilterOption<Value>>;
  onChange: (value: Value) => void;
  children?: ReactNode;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <Menu>
      <MenuTrigger
        aria-label={label}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {current.label}
        <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground/70" />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="min-w-40">
        {children ?? (
          <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as Value)}>
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
        className="w-56 shrink-0"
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
  condensed,
  inFlowSearchRef,
  setSearchOpen,
  setSearchFocusToken,
}: {
  condensed: boolean;
  inFlowSearchRef: RefObject<HTMLDivElement | null>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setSearchFocusToken: Dispatch<SetStateAction<number>>;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
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
  }, [condensed, inFlowSearchRef, setSearchFocusToken, setSearchOpen]);
}

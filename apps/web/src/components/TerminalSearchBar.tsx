import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
} from "react";
import { SearchOptionButton } from "~/components/search/SearchOptionButton";
import { TerminalActionButton } from "~/components/TerminalActionButton";
import { cn } from "~/lib/utils";

export interface TerminalSearchBarProps {
  readonly open: boolean;
  readonly docked: boolean;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly matchCount: number;
  readonly activeIndex: number;
  readonly truncated: boolean;
  readonly focusRequestId: number;
  readonly isFindShortcut: (event: KeyboardEvent) => boolean;
  readonly findShortcutLabel?: string;
  readonly onOpen: () => void;
  readonly onQueryChange: (query: string) => void;
  readonly onCaseSensitiveChange: (value: boolean) => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onClose: () => void;
}

export function TerminalSearchBar(props: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const lastFocusRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!props.open || lastFocusRequestIdRef.current === props.focusRequestId) return;
    lastFocusRequestIdRef.current = props.focusRequestId;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [props.focusRequestId, props.open]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const nativeEvent = event.nativeEvent;
    if (nativeEvent.key === "Escape") {
      props.onClose();
    } else if (props.isFindShortcut(nativeEvent)) {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    } else if (nativeEvent.key === "Enter" && event.target === inputRef.current) {
      (nativeEvent.shiftKey ? props.onPrevious : props.onNext)();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const keepInputFocus = (event: ReactMouseEvent<HTMLButtonElement>) => event.preventDefault();
  const count =
    props.query.length === 0
      ? ""
      : props.matchCount === 0
        ? "0/0"
        : `${props.activeIndex + 1}/${props.matchCount}${props.truncated ? "+" : ""}`;
  const actionClassName = "p-1 text-foreground/90 transition-colors hover:bg-accent";
  const navigationClassName = cn(
    actionClassName,
    props.matchCount === 0 && "pointer-events-none opacity-45",
  );
  const row = (
    <>
      <span className="relative flex w-36 items-center">
        <input
          ref={inputRef}
          type="text"
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          className="h-5 w-full bg-transparent pr-11 pl-1.5 text-xs leading-5 text-foreground outline-none placeholder:text-muted-foreground"
          placeholder="Find"
          aria-label="Find in terminal"
        />
        <span className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center text-[10px] text-muted-foreground/70 italic tabular-nums">
          {count}
        </span>
      </span>
      <div className="h-4 w-px bg-border/80" />
      <div className="flex" onMouseDown={(event) => event.preventDefault()}>
        <SearchOptionButton
          active={props.caseSensitive}
          label="Match case"
          className="h-5 w-6 min-w-0 rounded-none px-0 text-[11px]"
          onClick={() => props.onCaseSensitiveChange(!props.caseSensitive)}
        >
          Aa
        </SearchOptionButton>
      </div>
      <div className="h-4 w-px bg-border/80" />
      <TerminalActionButton
        icon={ChevronUp}
        label="Previous match"
        className={navigationClassName}
        onClick={props.onPrevious}
        onMouseDown={keepInputFocus}
      />
      <TerminalActionButton
        icon={ChevronDown}
        label="Next match"
        className={navigationClassName}
        onClick={props.onNext}
        onMouseDown={keepInputFocus}
      />
      <TerminalActionButton
        icon={X}
        label="Close find"
        className={actionClassName}
        onClick={props.onClose}
        onMouseDown={keepInputFocus}
      />
    </>
  );

  if (!props.docked) {
    if (!props.open) return null;
    return (
      <div
        onKeyDown={handleKeyDown}
        className="absolute right-2 top-2 z-20 inline-flex origin-right items-center overflow-hidden rounded-md border border-border/80 bg-background shadow-xs transition-[opacity,scale] duration-150 ease-out starting:scale-95 starting:opacity-0 motion-reduce:transition-none"
      >
        {row}
      </div>
    );
  }

  const label = `Find in terminal${props.findShortcutLabel ? ` (${props.findShortcutLabel})` : ""}`;
  return (
    <>
      {!props.open && <TerminalActionButton icon={Search} label={label} onClick={props.onOpen} />}
      <div
        inert={!props.open}
        onKeyDown={handleKeyDown}
        className={cn(
          "overflow-hidden transition-[max-width] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          props.open ? "max-w-80" : "max-w-0",
        )}
      >
        <div className="flex w-max items-center">{row}</div>
      </div>
    </>
  );
}

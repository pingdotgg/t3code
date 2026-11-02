import { useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useT } from "../../hooks/useI18n";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { cn } from "~/lib/utils";
import { formatThreadFindCount } from "./threadFind";
import { THREAD_DETAILS_CARD_GAP } from "./threadDetailsCardLayout";

interface ThreadFindBarProps {
  readonly open: boolean;
  readonly query: string;
  readonly matchCount: number;
  readonly counting?: boolean;
  readonly status: "loading" | "error" | null;
  readonly onRetry: () => void;
  readonly activeIndex: number;
  readonly focusRequestId: number;
  readonly onQueryChange: (query: string) => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onClose: () => void;
}

export const THREAD_FIND_BAR_RESERVED_HEIGHT = 36 + THREAD_DETAILS_CARD_GAP;

export function ThreadFindBar(props: ThreadFindBarProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses and selects the input DOM node when the bar opens or a find shortcut fires
  useEffect(() => {
    if (!props.open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each find shortcut bumps the request id, so an already-open bar refocuses and reselects its query.
    props.focusRequestId,
    props.open,
  ]);

  if (!props.open) return null;

  const hasQuery = props.query.trim().length > 0;
  const noResults = hasQuery && !props.status && props.matchCount === 0;
  let label = "";
  if (hasQuery) {
    label = props.counting ? "1/…" : formatThreadFindCount(props.activeIndex, props.matchCount);
  }
  if (props.status === "loading") label = t("chat.find.searching");
  if (props.status === "error") label = t("chat.find.failed");
  const navigationDisabled =
    props.matchCount === 0 || props.status === "loading" || props.counting === true;
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) props.onPrevious();
      else props.onNext();
    }
  };

  return (
    <div
      data-thread-find-bar
      className="absolute top-3 right-3 z-40 w-[min(var(--thread-details-panel-width),calc(100%-1.5rem))] transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none"
    >
      <InputGroup
        variant="popover"
        size="lg"
        onContextMenu={(event) => event.stopPropagation()}
        role="search"
        aria-label={t("chat.find.inThread")}
        aria-busy={props.status === "loading" || props.counting === true}
        className="w-full"
      >
        <InputGroupInput
          ref={inputRef}
          type="search"
          size="sm"
          value={props.query}
          aria-label={t("chat.find.inThread")}
          placeholder={t("chat.find.inThread")}
          maxLength={200}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => props.onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <InputGroupAddon align="inline-end" inset="pill">
          <span
            aria-live="polite"
            className={cn(
              "min-w-10 text-center text-xs tabular-nums",
              noResults ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          {props.status === "error" ? (
            <Button size="xs" variant="ghost" onClick={props.onRetry}>
              {t("chat.find.retry")}
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("chat.find.previous")}
            disabled={navigationDisabled}
            onClick={props.onPrevious}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("chat.find.next")}
            disabled={navigationDisabled}
            onClick={props.onNext}
          >
            <ChevronDownIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("chat.find.close")}
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

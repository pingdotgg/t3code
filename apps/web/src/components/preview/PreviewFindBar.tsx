import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { cn } from "~/lib/utils";
import { previewBridge } from "./previewBridge";

interface PreviewFindBarProps {
  readonly tabId: string;
  readonly focusRequestId: number;
  readonly onClose: () => void;
}

export function PreviewFindBar({ tabId, focusRequestId, onClose }: PreviewFindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ active: number; matches: number } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses and selects the input DOM node when the bar opens or a find shortcut fires
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each find shortcut bumps the request id, so an already-open bar refocuses and reselects its query.
  }, [focusRequestId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to Chromium find results for this tab and stops the search on unmount
  useEffect(() => {
    if (!previewBridge) return;
    const unsubscribe = previewBridge.onFindResult((event) => {
      if (event.tabId !== tabId) return;
      // Chromium reports -1 for a field an update leaves unchanged.
      setResult((previous) => ({
        active: event.activeMatchOrdinal >= 0 ? event.activeMatchOrdinal : (previous?.active ?? 0),
        matches: event.matches >= 0 ? event.matches : (previous?.matches ?? 0),
      }));
    });
    return () => {
      unsubscribe();
      void previewBridge?.stopFindInPage(tabId).catch(() => undefined);
    };
  }, [tabId]);

  const search = (text: string, options: { forward: boolean; newSession: boolean }) => {
    if (!previewBridge) return;
    void previewBridge.findInPage(tabId, text, options).catch(() => undefined);
  };

  const handleQueryChange = (next: string) => {
    setQuery(next);
    if (next.length === 0) {
      setResult(null);
      void previewBridge?.stopFindInPage(tabId).catch(() => undefined);
      return;
    }
    search(next, { forward: true, newSession: true });
  };

  const step = (forward: boolean) => {
    if (query.length === 0) return;
    search(query, { forward, newSession: false });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      step(!event.shiftKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const hasQuery = query.length > 0;
  const noResults = hasQuery && result !== null && result.matches === 0;
  const label =
    hasQuery && result ? `${result.matches === 0 ? 0 : result.active}/${result.matches}` : "";
  const navigationDisabled = !result || result.matches === 0;

  return (
    <div className="absolute top-3 right-3 z-40 w-[min(22rem,calc(100%-1.5rem))]">
      <InputGroup
        variant="popover"
        size="lg"
        role="search"
        aria-label="Find in page"
        className="w-full"
      >
        <InputGroupInput
          ref={inputRef}
          type="search"
          size="sm"
          value={query}
          aria-label="Find in page"
          placeholder="Find in page"
          maxLength={200}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => handleQueryChange(event.target.value)}
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
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Previous match"
            disabled={navigationDisabled}
            onClick={() => step(false)}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Next match"
            disabled={navigationDisabled}
            onClick={() => step(true)}
          >
            <ChevronDownIcon />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={onClose}>
            <XIcon />
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

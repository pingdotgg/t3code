import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState, type RefObject } from "react";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { ChatSearchRequest } from "./useChatSearchTarget";

export const CHAT_SEARCH_OPEN_EVENT = "t3code:search-current-chat";

/** Search persisted messages without downloading the conversation's full history. */
export function ChatSearch({
  threadRef,
  inputRef,
  onSelect,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  inputRef: RefObject<HTMLInputElement | null>;
  onSelect: (request: ChatSearchRequest | null) => void;
  onClose: () => void;
}) {
  const supportsSearch =
    useServerConfigs().get(threadRef.environmentId)?.environment.capabilities
      .threadMessageSearch === true;
  const [query, setQuery] = useState("");
  const normalized = query.trim();
  const debounced = useDebouncedValue(normalized, 200);
  const [selection, setSelection] = useState({ index: 0, activation: 0 });
  const atom = useMemo(
    () =>
      supportsSearch && debounced.length >= 2
        ? orchestrationEnvironment.threadSearch({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, query: debounced, limit: 50 },
          })
        : null,
    [debounced, supportsSearch, threadRef.environmentId, threadRef.threadId],
  );
  const search = useEnvironmentQuery(atom);
  useEffect(() => {
    if (atom) search.refresh();
  }, [atom, search.refresh]);
  const pending = normalized !== debounced || search.isPending;
  const matches = pending
    ? []
    : (search.data?.matches.filter((match) => match.messageId !== undefined) ?? []);
  const selected = matches[selection.index]?.messageId;

  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);
  useEffect(() => {
    onSelect(
      selected
        ? {
            messageId: selected,
            query: debounced,
            key: JSON.stringify([threadRef.threadId, debounced, selected, selection.activation]),
          }
        : null,
    );
  }, [debounced, onSelect, selected, selection.activation, threadRef.threadId]);

  const move = (delta: number) => {
    if (matches.length === 0) return;
    setSelection((current) => ({
      index: (current.index + delta + matches.length) % matches.length,
      activation: current.activation + 1,
    }));
  };

  return (
    <div
      role="search"
      aria-label="Search current chat"
      className="z-30 border-b border-border bg-background px-3 py-2"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        if (
          event.key === "Enter" &&
          !event.nativeEvent.isComposing &&
          event.target === inputRef.current
        ) {
          event.preventDefault();
          move(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <div className="flex items-center gap-1.5">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <Input
          ref={inputRef}
          size="compact"
          type="search"
          aria-label="Find in chat"
          data-chat-search-input
          placeholder="Find in chat…"
          className="min-w-0 flex-1"
          value={query}
          maxLength={200}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelection((current) => ({ index: 0, activation: current.activation + 1 }));
          }}
        />
        <span role="status" className="shrink-0 text-xs text-muted-foreground">
          {!supportsSearch
            ? "Unavailable"
            : normalized.length < 2
              ? "2+ characters"
              : pending
                ? "Searching…"
                : search.error
                  ? "Search failed"
                  : matches.length === 0
                    ? "No matches"
                    : `${selection.index + 1} of ${matches.length}${matches.length === 50 ? "+" : ""} ${matches.length === 1 ? "message" : "messages"}`}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous matching message"
          title="Previous matching message (Shift+Enter)"
          disabled={!matches.length}
          onClick={() => move(-1)}
        >
          <ChevronUpIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next matching message"
          title="Next matching message (Enter)"
          disabled={!matches.length}
          onClick={() => move(1)}
        >
          <ChevronDownIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close chat search"
          title="Close (Escape)"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      {!supportsSearch ? (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          Update this environment's server to search within a chat.
        </p>
      ) : null}
      {search.error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {search.error}
        </p>
      ) : null}
    </div>
  );
}

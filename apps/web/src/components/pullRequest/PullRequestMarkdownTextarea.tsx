import type {
  EnvironmentId,
  ProjectId,
  PullRequestActor,
  PullRequestDetailView,
  PullRequestRef,
} from "@t3tools/contracts";
import {
  detectPullRequestMention,
  insertPullRequestMention,
  narrowPullRequestMentions,
} from "@t3tools/shared/pullRequestComposerTrigger";
import { useId, useState, type Ref } from "react";
import { flushSync } from "react-dom";

import { cn } from "~/lib/utils";
import { usePullRequestFilterOptions } from "~/state/pullRequests";
import { useDebouncedValue } from "~/state/queries";

import { Popover, PopoverPopup } from "../ui/popover";
import { Textarea, type TextareaProps } from "../ui/textarea";
import { PullRequestActorAvatar } from "./pullRequestPresentation";

/** The repository whose users an `@` completes. */
export interface PullRequestMentionScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/** Null on hosts that cannot search their users, so `@` never opens a list that cannot fill. */
export function pullRequestMentionScope(
  detail: Pick<PullRequestDetailView, "capabilities">,
  environmentId: EnvironmentId,
  reference: PullRequestRef,
): PullRequestMentionScope | null {
  return detail.capabilities.mentions === true
    ? { environmentId, projectId: reference.projectId }
    : null;
}

const MENTION_SEARCH_DEBOUNCE_MS = 200;
const MENTION_SUGGESTION_LIMIT = 8;
// About a full list of suggestions. The popup fits itself to the space it opens into, so it never
// flips once results grow it; the side is picked up front from the room a full list needs.
const SUGGESTION_LIST_HEIGHT = 320;

function suggestionSide(target: HTMLTextAreaElement): "top" | "bottom" {
  const rect = target.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom;
  return below < SUGGESTION_LIST_HEIGHT && rect.top > below ? "top" : "bottom";
}

function useMentionCandidates(scope: PullRequestMentionScope | null, query: string | null) {
  const typed = query ?? "";
  const search = typed === "" ? undefined : typed.slice(0, 100);
  const sent = useDebouncedValue(search, MENTION_SEARCH_DEBOUNCE_MS);
  const hosted = usePullRequestFilterOptions(
    scope === null || query === null
      ? []
      : [
          {
            environmentId: scope.environmentId,
            input: {
              kind: "authors",
              projectId: scope.projectId,
              ...(sent ? { query: sent } : {}),
            },
          },
        ],
  );
  // Older answers stay useful while the debounced search catches up, narrowed to what is typed now.
  return {
    candidates: narrowPullRequestMentions(hosted.authors, typed, MENTION_SUGGESTION_LIMIT),
    isPending: hosted.isPending || sent !== search,
    failed: hosted.error !== null,
  };
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/** A markdown textarea for pull request text that completes `@login` from the repository's users. */
export function PullRequestMarkdownTextarea({
  ref,
  value,
  onValueChange,
  mentionScope,
  onKeyDown,
  onSelect,
  onFocus,
  onBlur,
  ...props
}: Omit<TextareaProps, "value" | "onChange"> & {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly mentionScope: PullRequestMentionScope | null;
}) {
  const listId = useId();
  const [element, setElement] = useState<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [side, setSide] = useState<"top" | "bottom">("bottom");
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [highlight, setHighlight] = useState({ query: "", index: 0 });

  const trigger =
    mentionScope === null || caret === null || props.readOnly
      ? null
      : detectPullRequestMention(value, caret);
  const open = trigger !== null && trigger.rangeStart !== dismissedAt;
  const { candidates, isPending, failed } = useMentionCandidates(
    mentionScope,
    open ? trigger.query : null,
  );
  const activeIndex =
    trigger !== null && highlight.query === trigger.query
      ? Math.min(highlight.index, Math.max(0, candidates.length - 1))
      : 0;
  const active = open ? candidates[activeIndex] : undefined;
  const optionId = (login: string) => `${listId}-${login}`;

  const syncCaret = (target: HTMLTextAreaElement) => {
    setSide(suggestionSide(target));
    setCaret(target.selectionStart === target.selectionEnd ? target.selectionStart : null);
  };

  const select = (actor: PullRequestActor) => {
    if (trigger === null || element === null) return;
    const next = insertPullRequestMention(value, trigger, actor.login);
    flushSync(() => onValueChange(next.text));
    element.setSelectionRange(next.cursor, next.cursor);
    setCaret(next.cursor);
  };

  return (
    <>
      <Textarea
        {...props}
        ref={(node) => {
          setElement(node);
          assignRef(ref, node);
        }}
        value={value}
        role={mentionScope === null ? undefined : "combobox"}
        aria-autocomplete={mentionScope === null ? undefined : "list"}
        aria-expanded={mentionScope === null ? undefined : open}
        aria-controls={open && candidates.length > 0 ? listId : undefined}
        aria-activedescendant={active ? optionId(active.login) : undefined}
        onChange={(event) => {
          onValueChange(event.target.value);
          syncCaret(event.target);
          setDismissedAt(null);
        }}
        onSelect={(event) => {
          syncCaret(event.currentTarget);
          onSelect?.(event);
        }}
        onFocus={(event) => {
          syncCaret(event.currentTarget);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setCaret(null);
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          // Some IMEs confirm a composition with an Enter that reports keyCode 229 but not isComposing.
          if (open && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            const handled = (() => {
              if (event.key === "Escape") {
                setDismissedAt(trigger.rangeStart);
                return true;
              }
              if (candidates.length === 0) return false;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const step = event.key === "ArrowDown" ? 1 : -1;
                setHighlight({
                  query: trigger.query,
                  index: (activeIndex + step + candidates.length) % candidates.length,
                });
                return true;
              }
              const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
              if ((event.key === "Enter" || event.key === "Tab") && plain && active) {
                select(active);
                return true;
              }
              return false;
            })();
            if (handled) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
          }
          onKeyDown?.(event);
        }}
      />
      <Popover
        open={open}
        modal={false}
        onOpenChange={(next, details) => {
          if (next || details.event?.target === element) return;
          if (trigger !== null) setDismissedAt(trigger.rangeStart);
        }}
      >
        <PopoverPopup
          anchor={element}
          side={side}
          align="start"
          padding="compact"
          width="sm"
          initialFocus={false}
          finalFocus={false}
        >
          {candidates.length > 0 ? (
            <div id={listId} role="listbox" aria-label="Mention a user" className="-mx-1.5">
              {candidates.map((actor, index) => (
                <div
                  key={actor.login}
                  id={optionId(actor.login)}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    index === activeIndex && "bg-accent text-accent-foreground",
                  )}
                  onMouseMove={() => {
                    if (index !== activeIndex) setHighlight({ query: trigger?.query ?? "", index });
                  }}
                  // Keeps focus, and the caret, in the textarea.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(actor)}
                >
                  <PullRequestActorAvatar actor={actor} className="size-5" />
                  <span className="truncate font-medium">{actor.login}</span>
                  {actor.name && actor.name !== actor.login ? (
                    <span className="min-w-0 truncate text-muted-foreground">{actor.name}</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="px-1 text-xs text-muted-foreground">
              {isPending
                ? "Searching users..."
                : failed
                  ? "Couldn't search users on the host"
                  : "No matching users"}
            </p>
          )}
        </PopoverPopup>
      </Popover>
    </>
  );
}

import type {
  EnvironmentId,
  ProjectId,
  PullRequestActor,
  PullRequestReferenceCandidate,
} from "@t3tools/contracts";
import {
  detectPullRequestComposerTrigger,
  insertPullRequestCompletion,
  narrowPullRequestMentions,
  narrowPullRequestReferences,
  pullRequestCompletionSearch,
  type PullRequestComposerTrigger,
} from "@t3tools/shared/pullRequestComposerTrigger";
import { CircleCheckIcon, CircleDotIcon } from "lucide-react";
import { useId, useState, type Ref } from "react";
import { flushSync } from "react-dom";

import { cn } from "~/lib/utils";
import { usePullRequestFilterOptions } from "~/state/pullRequests";
import { useDebouncedValue } from "~/state/queries";

import { Popover, PopoverPopup } from "../ui/popover";
import { Textarea, type TextareaProps } from "../ui/textarea";
import { PULL_REQUEST_STATE_PRESENTATION } from "./pullRequestIcons";
import { PullRequestActorAvatar, resolvePullRequestState } from "./pullRequestPresentation";

/** The repository whose users `@` completes and whose issues and change requests `#` does. */
export interface PullRequestCompletionScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

type Completion =
  | { readonly kind: "mention"; readonly token: string; readonly actor: PullRequestActor }
  | {
      readonly kind: "reference";
      readonly token: string;
      readonly candidate: PullRequestReferenceCandidate;
    };
// About a full list of suggestions. The popup fits itself to the space it opens into, so it never
// flips once results grow it; the side is picked up front from the room a full list needs.
const SUGGESTION_LIST_HEIGHT = 320;

function suggestionSide(target: HTMLTextAreaElement): "top" | "bottom" {
  const rect = target.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom;
  return below < SUGGESTION_LIST_HEIGHT && rect.top > below ? "top" : "bottom";
}

const COMPLETION_SEARCH_DEBOUNCE_MS = 200;
const COMPLETION_SUGGESTION_LIMIT = 8;

function useCompletions(
  scope: PullRequestCompletionScope | null,
  trigger: PullRequestComposerTrigger | null,
) {
  const search = trigger === null ? undefined : pullRequestCompletionSearch(trigger);
  const wanted = trigger === null ? null : `${trigger.kind}:${search ?? ""}`;
  const sentKey = useDebouncedValue(wanted, COMPLETION_SEARCH_DEBOUNCE_MS);
  // A switch between `@` and `#` asks at once; only a changing search waits for the debounce.
  const sent =
    trigger !== null && sentKey?.startsWith(`${trigger.kind}:`)
      ? sentKey.slice(trigger.kind.length + 1)
      : search;
  const hosted = usePullRequestFilterOptions(
    scope === null || trigger === null
      ? []
      : [
          {
            environmentId: scope.environmentId,
            input: {
              kind: trigger.kind === "mention" ? "authors" : "references",
              projectId: scope.projectId,
              ...(sent ? { query: sent } : {}),
            },
          },
        ],
  );
  // Older answers stay useful while the debounced search catches up, narrowed to what is typed now.
  const completions: ReadonlyArray<Completion> =
    trigger === null
      ? []
      : trigger.kind === "mention"
        ? narrowPullRequestMentions(hosted.authors, trigger.query, COMPLETION_SUGGESTION_LIMIT).map(
            (actor) => ({ kind: "mention", token: `@${actor.login}`, actor }),
          )
        : narrowPullRequestReferences(hosted.references, trigger, COMPLETION_SUGGESTION_LIMIT).map(
            (candidate) => ({ kind: "reference", token: candidate.reference, candidate }),
          );
  return {
    completions,
    isPending: hosted.isPending || sent !== search,
    failed: hosted.error !== null,
  };
}

function ReferenceStateIcon({ candidate }: { candidate: PullRequestReferenceCandidate }) {
  const presentation =
    candidate.kind === "change-request"
      ? resolvePullRequestState({ state: candidate.state, isDraft: false })
      : candidate.state === "open"
        ? {
            label: "Open issue",
            Icon: CircleDotIcon,
            toneClassName: PULL_REQUEST_STATE_PRESENTATION.open.toneClassName,
          }
        : {
            label: "Closed issue",
            Icon: CircleCheckIcon,
            toneClassName: PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
          };
  return (
    <presentation.Icon
      role="img"
      aria-label={presentation.label}
      className={cn("size-4 shrink-0", presentation.toneClassName)}
    />
  );
}

function CompletionRow({ completion }: { completion: Completion }) {
  if (completion.kind === "mention") {
    const { actor } = completion;
    return (
      <>
        <PullRequestActorAvatar actor={actor} className="size-5" />
        <span className="truncate font-medium">{actor.login}</span>
        {actor.name && actor.name !== actor.login ? (
          <span className="min-w-0 truncate text-muted-foreground">{actor.name}</span>
        ) : null}
      </>
    );
  }
  const { candidate } = completion;
  return (
    <>
      <ReferenceStateIcon candidate={candidate} />
      <span className="shrink-0 font-medium tabular-nums">{candidate.reference}</span>
      <span className="min-w-0 truncate text-muted-foreground">{candidate.title}</span>
    </>
  );
}

const EMPTY_STATE = {
  mention: {
    label: "Mention a user",
    pending: "Searching users...",
    failed: "Couldn't search users on the host",
    none: "No matching users",
  },
  reference: {
    label: "Reference an issue or change request",
    pending: "Searching...",
    failed: "Couldn't search the host",
    none: "No matching issues or change requests",
  },
} as const;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/** A markdown textarea for pull request text that completes `@login`, `#123` and GitLab `!123`. */
export function PullRequestMarkdownTextarea({
  ref,
  value,
  onValueChange,
  completionScope,
  onKeyDown,
  onSelect,
  onFocus,
  onBlur,
  ...props
}: Omit<TextareaProps, "value" | "onChange"> & {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly completionScope: PullRequestCompletionScope | null;
}) {
  const listId = useId();
  const [element, setElement] = useState<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [side, setSide] = useState<"top" | "bottom">("bottom");
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [highlight, setHighlight] = useState({ query: "", index: 0 });

  const trigger =
    completionScope === null || caret === null
      ? null
      : detectPullRequestComposerTrigger(value, caret);
  const open = trigger !== null && trigger.rangeStart !== dismissedAt;
  const {
    completions: candidates,
    isPending,
    failed,
  } = useCompletions(completionScope, open ? trigger : null);
  const activeIndex =
    trigger !== null && highlight.query === trigger.query
      ? Math.min(highlight.index, Math.max(0, candidates.length - 1))
      : 0;
  const active = open ? candidates[activeIndex] : undefined;
  const optionId = (token: string) => `${listId}-${token}`;

  const syncCaret = (target: HTMLTextAreaElement) => {
    setSide(suggestionSide(target));
    setCaret(target.selectionStart === target.selectionEnd ? target.selectionStart : null);
  };

  const select = (completion: Completion) => {
    if (trigger === null || element === null) return;
    const next = insertPullRequestCompletion(value, trigger, completion.token);
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
        role={completionScope === null ? undefined : "combobox"}
        aria-autocomplete={completionScope === null ? undefined : "list"}
        aria-expanded={completionScope === null ? undefined : open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={active ? optionId(active.token) : undefined}
        onChange={(event) => {
          onValueChange(event.target.value);
          syncCaret(event.target);
          if (
            detectPullRequestComposerTrigger(event.target.value, event.target.selectionStart) ===
            null
          )
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
          if (open && !event.nativeEvent.isComposing) {
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
          width={trigger?.kind === "reference" ? "md" : "sm"}
          initialFocus={false}
          finalFocus={false}
        >
          {candidates.length > 0 ? (
            <div
              id={listId}
              role="listbox"
              aria-label={EMPTY_STATE[trigger?.kind ?? "mention"].label}
              className="-mx-1.5"
            >
              {candidates.map((completion, index) => (
                <div
                  key={completion.token}
                  id={optionId(completion.token)}
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
                  onClick={() => select(completion)}
                >
                  <CompletionRow completion={completion} />
                </div>
              ))}
            </div>
          ) : (
            <p className="px-1 text-xs text-muted-foreground">
              {
                EMPTY_STATE[trigger?.kind ?? "mention"][
                  isPending ? "pending" : failed ? "failed" : "none"
                ]
              }
            </p>
          )}
        </PopoverPopup>
      </Popover>
    </>
  );
}

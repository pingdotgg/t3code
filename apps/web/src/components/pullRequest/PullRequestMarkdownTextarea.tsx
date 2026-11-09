import { t } from "@palamedes/core/macro";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestReferenceCandidate,
} from "@t3tools/contracts";
import {
  debouncedPullRequestCompletionSearch,
  detectPullRequestComposerTrigger,
  insertPullRequestCompletion,
  pullRequestCompletionKey,
  pullRequestCompletions,
  type PullRequestCompletion,
  type PullRequestCompletionSupport,
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
  readonly support: PullRequestCompletionSupport;
}

/** Null on hosts that complete nothing, so no sigil opens a list that cannot fill. */
export function pullRequestCompletionScope(
  detail: Pick<PullRequestDetailView, "capabilities">,
  environmentId: EnvironmentId,
  reference: PullRequestRef,
): PullRequestCompletionScope | null {
  const { mentions, referenceSigils } = detail.capabilities;
  return mentions === true || (referenceSigils?.length ?? 0) > 0
    ? { environmentId, projectId: reference.projectId, support: { mentions, referenceSigils } }
    : null;
}
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
  const key = pullRequestCompletionKey(trigger);
  const sentKey = useDebouncedValue(key, COMPLETION_SEARCH_DEBOUNCE_MS);
  const sent =
    trigger === null ? undefined : debouncedPullRequestCompletionSearch(trigger, sentKey);
  const hosted = usePullRequestFilterOptions(
    scope === null || trigger === null
      ? []
      : [
          {
            environmentId: scope.environmentId,
            input:
              trigger.kind === "mention"
                ? { kind: "authors", projectId: scope.projectId, ...(sent ? { query: sent } : {}) }
                : {
                    kind: "references",
                    projectId: scope.projectId,
                    sigil: trigger.sigil,
                    ...(sent ? { query: sent } : {}),
                  },
          },
        ],
  );
  // Older answers stay useful while the debounced search catches up, narrowed to what is typed now.
  const completions = pullRequestCompletions(trigger, hosted, COMPLETION_SUGGESTION_LIMIT);
  return {
    completions,
    isPending: hosted.isPending || sentKey !== key,
    failed: hosted.error !== null,
  };
}

function ReferenceStateIcon({ candidate }: { candidate: PullRequestReferenceCandidate }) {
  const presentation =
    candidate.kind === "change-request"
      ? resolvePullRequestState({ state: candidate.state, isDraft: false })
      : candidate.state === "open"
        ? {
            label: t({ message: "Open issue" }),
            Icon: CircleDotIcon,
            toneClassName: PULL_REQUEST_STATE_PRESENTATION.open.toneClassName,
          }
        : {
            label: t({ message: "Closed issue" }),
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

function CompletionRow({ completion }: { completion: PullRequestCompletion }) {
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
    get label() {
      return t({ message: "Mention a user" });
    },
    pending: "Searching users...",
    failed: "Couldn't search users on the host",
    none: "No matching users",
  },
  reference: {
    get label() {
      return t({ message: "Reference an issue or change request" });
    },
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
    completionScope === null || caret === null || props.readOnly
      ? null
      : detectPullRequestComposerTrigger(value, caret, completionScope.support);
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

  const select = (completion: PullRequestCompletion) => {
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
        aria-controls={open && candidates.length > 0 ? listId : undefined}
        aria-activedescendant={active ? optionId(active.token) : undefined}
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

import type { EnvironmentIssueEntry } from "@t3tools/client-runtime/issue-list";
import { MessageSquareIcon } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import {
  PullRequestLabelChip,
  PullRequestActorAvatar,
} from "../pullRequest/pullRequestPresentation";
import { IssueStateGlyph, issueTrackerPresentation } from "./issuePresentation";

export type IssueRowTarget = Pick<
  EnvironmentIssueEntry,
  "environmentId" | "projectId" | "tracker" | "host" | "scope" | "key" | "url"
>;

const decorationListeners = new WeakMap<Element, (visible: boolean) => void>();
const observedDocuments = new WeakSet<Document>();

function useIssueRowDecorations(deferred: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const [nearViewport, setNearViewport] = useState(!deferred);
  const observe = deferred && typeof ContentVisibilityAutoStateChangeEvent !== "undefined";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- only mount decorations near the viewport; the searchable row stays mounted
  useLayoutEffect(() => {
    const row = ref.current;
    const alreadyMounted = mounted.current;
    mounted.current = true;
    if (!observe || !row) return;
    const owner = row.ownerDocument;
    if (!observedDocuments.has(owner)) {
      owner.addEventListener(
        "contentvisibilityautostatechange",
        (event) => {
          if (event.target instanceof Element) {
            decorationListeners.get(event.target)?.(
              !(event as ContentVisibilityAutoStateChangeEvent).skipped,
            );
          }
        },
        true,
      );
      observedDocuments.add(owner);
    }
    decorationListeners.set(row, setNearViewport);
    // When pagination enables deferral, check the child. The row box stays visible even
    // when content-visibility skips its contents.
    if (alreadyMounted) {
      setNearViewport(
        row.firstElementChild?.checkVisibility?.({ contentVisibilityAuto: true }) ?? true,
      );
    }
    return () => {
      decorationListeners.delete(row);
    };
  }, [observe]);

  return { ref, decorated: !observe || nearViewport };
}

/** The page row in the pull-request list's shape: state glyph, then key and title over meta. */
function IssueRowImpl({
  entry,
  selected,
  showScope,
  showTracker,
  environmentLabel,
  onSelect,
  deferDecorations = false,
}: {
  entry: EnvironmentIssueEntry;
  selected: boolean;
  /** Only when the list spans more than one scope, where the key alone is ambiguous. */
  showScope: boolean;
  /** Only when the list spans more than one tracker or host. */
  showTracker: boolean;
  /** Names the server this row was read from, where the list spans more than one. */
  environmentLabel?: string | undefined;
  onSelect: (entry: IssueRowTarget) => void;
  deferDecorations?: boolean;
}) {
  const tracker = issueTrackerPresentation(entry.tracker);
  const { ref, decorated } = useIssueRowDecorations(deferDecorations);
  return (
    <div
      ref={ref}
      className={cn(
        "flex items-center rounded-md [content-visibility:auto] [contain-intrinsic-block-size:56.5px]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(entry)}
        className={cn(PULL_REQUEST_ROW_CLASS, "@container/issue-row-meta px-3 py-2.5")}
      >
        {decorated ? (
          <IssueStateGlyph state={entry.state} />
        ) : (
          <span role="img" aria-label={entry.state.name} className="size-4 shrink-0" />
        )}
        <PullRequestRowLines
          number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>{entry.displayKey}</span>}
          title={entry.title}
          status={
            <>
              {decorated && entry.assignees.length > 0 ? (
                <span className="flex items-center -space-x-1">
                  {entry.assignees.slice(0, 3).map((assignee) => (
                    <PullRequestActorAvatar
                      key={assignee.login}
                      actor={assignee}
                      className="ring-1 ring-background"
                    />
                  ))}
                </span>
              ) : null}
              {entry.commentCount > 0 ? (
                <span className="inline-flex items-center gap-0.5 tabular-nums">
                  <MessageSquareIcon aria-hidden className="size-3" />
                  {entry.commentCount}
                </span>
              ) : null}
            </>
          }
          meta={
            <>
              {decorated ? (
                <PullRequestRowAuthor actor={entry.author} />
              ) : (
                <span className="min-w-0 truncate ps-4.5">{entry.author?.login ?? "ghost"}</span>
              )}
              {showTracker ? (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <tracker.Icon aria-hidden className="size-3" />
                  <span className="sr-only">{tracker.providerName}</span>
                </span>
              ) : null}
              {showScope ? <span className="truncate">{entry.scope}</span> : null}
              {environmentLabel ? <span className="truncate">{environmentLabel}</span> : null}
              {entry.labels.length > 0 ? (
                <span className="hidden min-w-0 items-center gap-1 @xl/issue-row-meta:flex">
                  {entry.labels.slice(0, 3).map((label, index) => (
                    <PullRequestLabelChip key={label.name} label={label}>
                      {index === 2 && entry.labels.length > 3 ? (
                        <span className="shrink-0">+{entry.labels.length - 3}</span>
                      ) : null}
                    </PullRequestLabelChip>
                  ))}
                </span>
              ) : null}
            </>
          }
          updatedAt={entry.updatedAt}
        />
      </button>
    </div>
  );
}

export const IssueRow = memo(IssueRowImpl);

/**
 * A run of comments folded into one row of a timeline rail. Both rails count the run the same way —
 * how many comments, how many people, when it started — and hang the same faces off the marker, so
 * the fold and the words for it are written once.
 *
 * A comment's body is only built while the run is open, which is what makes folding worth anything:
 * a thread of a hundred markdown bodies costs a heading until somebody asks for it.
 */
import type { SourceControlActor } from "@t3tools/contracts";
import { ChevronDownIcon, MessageSquareIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { TimelineComment } from "./TimelineComment";
import { ActorTimelineMarker, uniqueConversationActors } from "./TimelineRail";

/** All a run of comments is read for here; whatever else an entry carries stays the caller's. */
type ConversationEntry = {
  readonly id: string;
  readonly actor: SourceControlActor | null;
  readonly title: string;
  readonly at: string;
  readonly url: string | null;
};

export function ConversationGroup<Entry extends ConversationEntry>({
  entries,
  onOpen,
  renderBadge,
  renderMeta,
  renderActions,
  renderBody,
}: {
  entries: ReadonlyArray<Entry>;
  onOpen: (url: string) => void;
  /** Said beside a comment's title, for what the surface adds to it — a review's own state. */
  renderBadge?: (entry: Entry) => ReactNode;
  /** Further segments for a comment's meta line — the file a review comment hangs on. */
  renderMeta?: (entry: Entry) => ReactNode;
  renderActions?: (entry: Entry) => ReactNode;
  renderBody: (entry: Entry) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const actors = uniqueConversationActors(entries);
  const first = entries[0];
  if (first === undefined) return null;

  return (
    <div className="relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      <ActorTimelineMarker
        actors={actors}
        className="top-6"
        fallback={<MessageSquareIcon className="size-3.5" />}
        muted={!open}
      />
      <Collapsible open={open} onOpenChange={setOpen}>
        <div>
          <CollapsibleTrigger
            className={cn(
              "flex w-full min-w-0 items-center gap-3 py-2 text-left transition-opacity hover:opacity-100",
              open ? "text-foreground opacity-100" : "text-muted-foreground opacity-55",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold">
                {entries.length.toLocaleString()} {entries.length === 1 ? "comment" : "comments"}
              </span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {actors.length.toLocaleString()} {actors.length === 1 ? "author" : "authors"} ·{" "}
                {formatRelativeTimeLabel(first.at)}
              </span>
            </span>
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            {open ? (
              <div className="mt-1 space-y-1">
                {entries.map((entry) => (
                  <TimelineComment
                    key={entry.id}
                    actor={entry.actor}
                    title={entry.title}
                    at={entry.at}
                    url={entry.url}
                    onOpen={onOpen}
                    badge={renderBadge?.(entry)}
                    meta={renderMeta?.(entry)}
                    actions={renderActions?.(entry)}
                    body={renderBody(entry)}
                  />
                ))}
              </div>
            ) : null}
          </CollapsiblePanel>
        </div>
      </Collapsible>
    </div>
  );
}

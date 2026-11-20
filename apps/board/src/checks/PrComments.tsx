import type { PullRequestActivity } from "@t3tools/contracts";
import { MessageSquare } from "lucide-react";
import { useMemo, useState } from "react";

import { CommentCard } from "./CommentCard";
import { type Audience, audienceCounts, conversationItems, filterByAudience } from "./conversation";

const PAGE = 30;
const AUDIENCES = [
  ["all", "All"],
  ["humans", "Humans"],
  ["bots", "Bots"],
] as const satisfies ReadonlyArray<readonly [Audience, string]>;

const EMPTY = { all: "No comments yet.", humans: "No human comments.", bots: "No bot comments." };

/** The pull request's comments and review threads, oldest first and the latest page shown, with Orca's All, Humans, and Bots filter. */
export function PrComments({ activity }: { activity: PullRequestActivity | null }) {
  const [audience, setAudience] = useState<Audience>("all");
  const [shown, setShown] = useState(PAGE);
  const items = useMemo(() => (activity === null ? [] : conversationItems(activity)), [activity]);
  const counts = audienceCounts(items);
  const filtered = filterByAudience(items, audience);
  const page = filtered.slice(Math.max(0, filtered.length - shown));
  return (
    <section
      aria-label="Comments"
      data-testid="pr-comments"
      className="flex flex-col border-t border-line"
    >
      <div className="sticky top-0 z-10 flex flex-col gap-2.5 border-b border-line bg-panel/95 px-3 py-2.5 backdrop-blur-sm">
        <h3 className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
          <MessageSquare className="size-3.5" aria-hidden />
          Comments
          <span
            data-testid="pr-comments-count"
            className="rounded-full border border-line bg-message px-1.5 py-px text-[10px] font-semibold tabular-nums text-muted"
          >
            {counts.all}
          </span>
        </h3>
        <div
          role="tablist"
          aria-label="Comment filter"
          className="grid grid-cols-3 rounded-md border border-line bg-bg p-0.5"
        >
          {AUDIENCES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={audience === id}
              data-testid={`pr-comments-${id}`}
              onClick={() => {
                setAudience(id);
                setShown(PAGE);
              }}
              className={`flex h-7 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] font-medium transition-colors ${audience === id ? "bg-message text-fg shadow-xs" : "text-muted hover:text-fg"}`}
            >
              <span>{label}</span>
              <span className="tabular-nums">{counts[id]}</span>
            </button>
          ))}
        </div>
      </div>
      {activity === null ? (
        <p className="py-5 text-center text-[11px] text-muted">Loading comments</p>
      ) : filtered.length === 0 ? (
        <p className="py-5 text-center text-[11px] text-muted">{EMPTY[audience]}</p>
      ) : (
        <ul className="flex flex-col gap-2 px-3 py-2">
          {filtered.length > page.length && (
            <li>
              <button
                type="button"
                onClick={() => setShown(shown + PAGE)}
                className="w-full rounded-md py-1 text-[12px] text-muted hover:bg-hover hover:text-fg"
              >
                Show {Math.min(PAGE, filtered.length - page.length)} earlier of{" "}
                {filtered.length - page.length}
              </button>
            </li>
          )}
          {page.map((item) => (
            <CommentCard key={item.id} item={item} />
          ))}
        </ul>
      )}
      {activity?.commentsTruncated === true && (
        <p className="pb-2 text-center text-[10px] text-muted">
          GitHub returned only the first {activity.comments.length} comments.
        </p>
      )}
    </section>
  );
}

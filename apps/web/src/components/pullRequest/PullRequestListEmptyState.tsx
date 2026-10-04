/**
 * The pull request list's words and drawing for an empty page; the states themselves are the
 * shared `ListEmptyState`.
 */
import type { ComponentProps } from "react";

import { ListEmptyState } from "../sourceControl/ListEmptyState";

/**
 * Drawn at the weight of the icons beside it rather than as an illustration with its own
 * palette, so an empty page reads as the same surface with nothing on it. Two branch lines and
 * the node where a change would land: nothing found leaves the branch unjoined, and the gap is
 * the whole picture, so it is drawn once and the variants only decide whether the seam closes.
 */
function BranchMark({ joined }: { joined: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 120 72"
      className="h-20 w-32 text-muted-foreground/60"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* The base line the change would land on, always whole. */}
      <path d="M10 58h100" className="text-muted-foreground/30" stroke="currentColor" />
      <circle cx="10" cy="58" r="5" fill="currentColor" fillOpacity={0.25} />
      <circle cx="110" cy="58" r="5" fill="currentColor" fillOpacity={0.25} />
      {joined ? (
        // A branch that leaves the base and comes back: the shape of a change that landed.
        <path d="M30 58c0-18 8-26 24-26h12c16 0 24 8 24 26" />
      ) : (
        <>
          {/* The same branch, stopped short. What is missing is the join, so that is what the
              drawing withholds. */}
          <path d="M30 58c0-18 8-26 24-26h4" />
          <path
            d="M90 58c0-18-8-26-24-26h-4"
            strokeDasharray="2 7"
            className="text-muted-foreground/50"
          />
        </>
      )}
      <circle
        cx="60"
        cy="32"
        r={joined ? 5 : 4}
        fill={joined ? "currentColor" : "none"}
        fillOpacity={0.25}
        className={joined ? undefined : "text-muted-foreground/45"}
      />
    </svg>
  );
}

type StateProps = Omit<
  ComponentProps<typeof ListEmptyState>,
  | "mark"
  | "loadingLabel"
  | "noProjectsDescription"
  | "notFoundHint"
  | "emptyTitle"
  | "emptyDescription"
  | "loadMoreLabel"
>;

export function PullRequestListEmptyState(props: StateProps) {
  return (
    <ListEmptyState
      {...props}
      mark={<BranchMark joined={false} />}
      loadingLabel="Loading pull requests"
      noProjectsDescription="Add a project, and the pull requests from its repository appear here."
      notFoundHint="The hosts were searched for it. Try fewer words, or search by number, author or branch."
      emptyTitle="No pull requests"
      emptyDescription="Pull requests from every project in this workspace appear here."
      loadMoreLabel="Load more pull requests"
    />
  );
}

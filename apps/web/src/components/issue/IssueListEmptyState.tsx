/**
 * The issue list's words and drawing for an empty page; the states themselves are the shared
 * `ListEmptyState`.
 */
import type { ComponentProps } from "react";

import { ListEmptyState } from "../sourceControl/ListEmptyState";

/**
 * Drawn at the weight of the icons beside it rather than as an illustration with its own palette,
 * so an empty page reads as the same surface with nothing on it. The ring is whole — an issue is
 * a thing somebody opened, and there is nothing broken about not having one — while the row it
 * would sit on trails off into the space where its title would be.
 */
function IssueMark() {
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
      <circle cx="24" cy="36" r="12" />
      <circle cx="24" cy="36" r="3.5" fill="currentColor" fillOpacity={0.25} stroke="none" />
      {/* The title line of the row that is not there, and the meta line under it, withheld. */}
      <path d="M48 30h60" className="text-muted-foreground/30" stroke="currentColor" />
      <path
        d="M48 44h34"
        strokeDasharray="2 7"
        className="text-muted-foreground/50"
        stroke="currentColor"
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

export function IssueListEmptyState(props: StateProps) {
  return (
    <ListEmptyState
      {...props}
      mark={<IssueMark />}
      loadingLabel="Loading issues"
      noProjectsDescription="Add a project, and the issues from its repository appear here."
      notFoundHint="The hosts were searched for it. Try fewer words, or search by number, author or label."
      emptyTitle="No issues"
      emptyDescription="Issues from every project in this workspace appear here."
      loadMoreLabel="Load more issues"
    />
  );
}

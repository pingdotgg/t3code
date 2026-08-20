/**
 * What a list of issues or of pull requests shows when it has no rows to show. The four states
 * and which of them offer to ask the hosts again are the same question on both surfaces, so they
 * are decided once here; the drawing and the words each surface says for itself arrive as props.
 *
 * An empty page and an unread one look the same, so the states that are showing a host's answer
 * offer to ask for it again. The two that are not — a search still in flight, and a workspace
 * with no project to read from — leave the button out, since pressing it could only repeat what
 * is already happening or ask nobody.
 */
import { PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { Button } from "../ui/button";
import { ListGhost } from "./ListGhosts";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

/** A pasted paragraph is still a search, but it is not a title. */
function shortened(query: string): string {
  return query.length > 48 ? `${query.slice(0, 48)}…` : query;
}

export function ListEmptyState({
  mark,
  loadingLabel,
  noProjectsDescription,
  notFoundHint,
  emptyTitle,
  emptyDescription,
  loadMoreLabel,
  query,
  filtered,
  searching,
  hasProjects,
  canLoadMore,
  loadingMore,
  refreshing,
  onClearQuery,
  onLoadMore,
  onRefresh,
}: {
  /** The surface's own drawing, at the weight of the icons beside it. */
  mark: ReactNode;
  loadingLabel: string;
  noProjectsDescription: string;
  /** What else the reader could search by, once the hosts have found nothing. */
  notFoundHint: string;
  emptyTitle: string;
  emptyDescription: string;
  loadMoreLabel: string;
  /** The text being searched for, so the reader is told what was searched rather than guessing. */
  query: string;
  /** True when a state, involvement, host or project filter is narrowing the list. */
  filtered: boolean;
  /** A search is in flight; the rows on screen are the previous answer. */
  searching: boolean;
  /**
   * Whether this environment holds a project at all. The list is assembled from the projects'
   * remotes, so without one there is no host to ask and no filter or search that could help.
   */
  hasProjects: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  /** A re-read of the hosts is already running, from here or from the header. */
  refreshing: boolean;
  onClearQuery: () => void;
  onLoadMore: () => void;
  onRefresh: () => void;
}) {
  // Ahead of the search and the filters, because neither can produce a row until a project does.
  if (!hasProjects) {
    return (
      <Empty className="py-16">
        {mark}
        <EmptyHeader>
          <EmptyTitle>No projects in this workspace</EmptyTitle>
          <EmptyDescription>{noProjectsDescription}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => openCommandPalette({ open: "add-project" })}>
            <PlusIcon className="size-3.5" />
            Add project
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (searching) {
    // The same ghost the first load wears, so a search on its way and a list on its way are
    // one state to the eye — with the question named where the group headers usually speak.
    return (
      <ListGhost
        label={loadingLabel}
        rows={5}
        caption={`Searching every host for “${shortened(query)}”`}
      />
    );
  }

  if (query.length > 0) {
    return (
      <Empty className="py-16">
        {mark}
        <EmptyHeader>
          <EmptyTitle>Nothing matches “{shortened(query)}”</EmptyTitle>
          <EmptyDescription>{notFoundHint}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          <Button size="sm" variant="outline" onClick={onClearQuery}>
            <SearchIcon className="size-3.5" />
            Clear search
          </Button>
          {/* The hosts answered this query once; anything filed since then would answer
              differently, and nothing on screen says which of the two the reader is looking at. */}
          <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
            <RefreshCwIcon className="size-3.5" />
            {refreshing ? "Checking..." : "Check again"}
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Empty className="py-16">
      {mark}
      <EmptyHeader>
        <EmptyTitle>{filtered ? "Nothing under these filters" : emptyTitle}</EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "Widen the state, involvement or project filter to see more."
            : emptyDescription}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center gap-2">
        {canLoadMore ? (
          <Button size="sm" variant="outline" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "Loading..." : loadMoreLabel}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
          <RefreshCwIcon className="size-3.5" />
          {refreshing ? "Checking..." : "Check again"}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

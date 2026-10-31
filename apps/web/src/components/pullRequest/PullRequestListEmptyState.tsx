import { RefreshIcon } from "~/components/ui/refresh-icon";
/** Every variant wears the same small notice the design gives a list filtered to nothing:
 * one glyph, a title, a sentence and the buttons that change the answer. */
import { FolderPlusIcon, PlusIcon, SearchIcon } from "lucide-react";
import type { ElementType, ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { Button } from "../ui/button";
import { PullRequestListGhost } from "./PullRequestGhosts";
import { PullRequestGlyph } from "./pullRequestIcons";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

/** The list's one notice shape, shared with the page's unavailable and sign-in states. */
export function PullRequestListNotice({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: ElementType<{ className?: string; "aria-hidden"?: boolean }>;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Empty size="compact">
      <Icon aria-hidden className="size-5.5 text-dim-foreground" />
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children ? <div className="flex flex-wrap justify-center gap-2">{children}</div> : null}
    </Empty>
  );
}

function CheckAgainButton({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <Button size="sm" variant="secondary" disabled={refreshing} onClick={onRefresh}>
      <RefreshIcon size="sm" refreshing={refreshing} />
      {refreshing ? "Checking..." : "Check again"}
    </Button>
  );
}

export function PullRequestListEmptyState({
  query,
  filtered,
  filterSummary,
  searching,
  hasProjects,
  signIn,
  canLoadMore,
  loadingMore,
  refreshing,
  onClearQuery,
  onClearFilters,
  onLoadMore,
  onRefresh,
}: {
  query: string;
  filtered: boolean;
  /** The active filters as one sentence, said where the list would be. */
  filterSummary: string | null;
  searching: boolean;
  hasProjects: boolean;
  /**
   * Every host the projects live on is signed out or missing its CLI, so the empty list is not
   * an answer. Carries the host's own name and the server's words for the fix.
   */
  signIn: {
    hostLabel: string;
    changeRequestPlural: string;
    detail: string | null;
    Icon: ElementType;
  } | null;
  canLoadMore: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  onClearQuery: () => void;
  /** Puts every filter back to its default: open, all involvement, nothing narrowed. */
  onClearFilters: () => void;
  onLoadMore: () => void;
  onRefresh: () => void;
}) {
  if (!hasProjects) {
    return (
      <PullRequestListNotice
        icon={FolderPlusIcon}
        title="No projects in this workspace"
        description="Add a project, and the pull requests from its repository appear here."
      >
        <Button
          size="sm"
          variant="secondary"
          onClick={() => openCommandPalette({ open: "add-project" })}
        >
          <PlusIcon className="size-3.5" />
          Add project
        </Button>
      </PullRequestListNotice>
    );
  }

  // Ahead of the filters too: nothing they narrow was read.
  if (signIn) {
    return (
      <PullRequestListNotice
        icon={signIn.Icon}
        title={`Sign in to ${signIn.hostLabel}`}
        description={
          signIn.detail ??
          `Sign in to ${signIn.hostLabel} on this server to see ${signIn.changeRequestPlural}.`
        }
      >
        <CheckAgainButton refreshing={refreshing} onRefresh={onRefresh} />
      </PullRequestListNotice>
    );
  }

  if (searching) {
    return (
      <PullRequestListGhost
        rows={5}
        caption={`Searching every host for “${query.length > 48 ? `${query.slice(0, 48)}…` : query}”`}
      />
    );
  }

  if (query.length > 0) {
    return (
      <PullRequestListNotice
        icon={SearchIcon}
        title={`Nothing matches “${query.length > 48 ? `${query.slice(0, 48)}…` : query}”`}
        description="The hosts were searched for it. Try fewer words, or search by number, author or branch."
      >
        <Button size="sm" variant="secondary" onClick={onClearQuery}>
          Clear search
        </Button>
        {}
        <CheckAgainButton refreshing={refreshing} onRefresh={onRefresh} />
      </PullRequestListNotice>
    );
  }

  if (filtered) {
    return (
      <PullRequestListNotice
        icon={PullRequestGlyph.closed}
        title="No pull requests match"
        description={filterSummary ?? "Widen the filters to see more."}
      >
        <Button size="sm" variant="secondary" onClick={onClearFilters}>
          Clear filters
        </Button>
        {/* The filters were only applied to the pages read so far. */}
        {canLoadMore ? (
          <Button size="sm" variant="secondary" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "Loading..." : "Load more pull requests"}
          </Button>
        ) : null}
      </PullRequestListNotice>
    );
  }

  return (
    <PullRequestListNotice
      icon={PullRequestGlyph.pullRequest}
      title="No open pull requests"
      description="Open pull requests from every project in this workspace appear here."
    >
      {canLoadMore ? (
        <Button size="sm" variant="secondary" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? "Loading..." : "Load more pull requests"}
        </Button>
      ) : null}
      <CheckAgainButton refreshing={refreshing} onRefresh={onRefresh} />
    </PullRequestListNotice>
  );
}

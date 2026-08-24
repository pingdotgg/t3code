/**
 * What the list shows when it has no rows to show.
 *
 * The drawing is the page's own subject rather than a stock empty box: two branch lines and the
 * node where a change would land, in the stroke language the row icons already use. Nothing
 * found leaves the branch unjoined — the gap is the whole picture, so it is drawn once and the
 * variants only decide whether the seam closes.
 *
 * An empty page and an unread one look the same, so the states that are showing a host's answer
 * offer to ask for it again. The two that are not — a search still in flight, and a workspace
 * with no project to read from — leave the button out, since pressing it could only repeat what
 * is already happening or ask nobody.
 */
import { PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useI18n } from "../../i18n";
import { Button } from "../ui/button";
import { PullRequestListGhost } from "./PullRequestGhosts";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

/**
 * Drawn at the weight of the icons beside it rather than as an illustration with its own
 * palette, so an empty page reads as the same surface with nothing on it.
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

export function PullRequestListEmptyState({
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
  /** The text being searched for, so the reader is told what was searched rather than guessing. */
  query: string;
  /** True when a state, involvement or project filter is narrowing the list. */
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
  const { t } = useI18n();
  const visibleQuery = query.length > 48 ? `${query.slice(0, 48)}…` : query;
  // Ahead of the search and the filters, because neither can produce a row until a project does.
  if (!hasProjects) {
    return (
      <Empty className="py-16">
        <BranchMark joined={false} />
        <EmptyHeader>
          <EmptyTitle>{t("pullRequest.empty.noProjects")}</EmptyTitle>
          <EmptyDescription>{t("pullRequest.empty.noProjectsDescription")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => openCommandPalette({ open: "add-project" })}>
            <PlusIcon className="size-3.5" />
            {t("sidebar.addProject")}
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (searching) {
    // The same ghost the first load wears, so a search on its way and a list on its way are
    // one state to the eye — with the question named where the group headers usually speak.
    return (
      <PullRequestListGhost
        rows={5}
        caption={t("pullRequest.empty.searchingHosts", { query: visibleQuery })}
      />
    );
  }

  if (query.length > 0) {
    return (
      <Empty className="py-16">
        <BranchMark joined={false} />
        <EmptyHeader>
          {/* A pasted paragraph is still a search, but it is not a title. */}
          <EmptyTitle>{t("pullRequest.empty.noMatch", { query: visibleQuery })}</EmptyTitle>
          <EmptyDescription>{t("pullRequest.empty.noMatchDescription")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          <Button size="sm" variant="outline" onClick={onClearQuery}>
            <SearchIcon className="size-3.5" />
            {t("pullRequest.empty.clearSearch")}
          </Button>
          {/* The hosts answered this query once; a pull request opened since then would answer
              differently, and nothing on screen says which of the two the reader is looking at. */}
          <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
            <RefreshCwIcon className="size-3.5" />
            {refreshing ? t("pullRequest.empty.checking") : t("pullRequest.empty.checkAgain")}
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Empty className="py-16">
      <BranchMark joined={false} />
      <EmptyHeader>
        <EmptyTitle>
          {filtered ? t("pullRequest.empty.filtered") : t("pullRequest.empty.none")}
        </EmptyTitle>
        <EmptyDescription>
          {filtered
            ? t("pullRequest.empty.filteredDescription")
            : t("pullRequest.empty.noneDescription")}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center gap-2">
        {canLoadMore ? (
          <Button size="sm" variant="outline" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? t("common.loading") : t("pullRequest.empty.loadMore")}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
          <RefreshCwIcon className="size-3.5" />
          {refreshing ? t("pullRequest.empty.checking") : t("pullRequest.empty.checkAgain")}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

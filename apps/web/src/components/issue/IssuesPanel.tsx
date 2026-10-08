import type {
  EnvironmentId,
  IssueInvolvement,
  IssueListOrder,
  IssueListSort,
  IssueListEntry,
  IssueListState,
  IssueLinkedPullRequest,
  ProjectId,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  AtSignIcon,
  CircleCheckIcon,
  CircleDotIcon,
  LayersIcon,
  PenLineIcon,
  UserCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { IssuesSurface } from "~/rightPanelStore";
import { openLinkInBrowser, relatedIssueTarget } from "~/lib/openIssueLink";
import { useProjects } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import type { IssueTabStatus } from "../RightPanelTabs";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { ScrollArea } from "../ui/scroll-area";
import { IssueDetailPanel, type IssueHandoffTarget } from "./IssueDetailPanel";
import { ListGhost } from "../sourceControl/ListGhosts";
import {
  filterIssueQueryResults,
  filterIssuesByInvolvement,
  issueEntryKey,
  rankIssueMatches,
  type IssueViewers,
} from "./issueList.logic";
import { IssueFiltersMenu, IssueSortMenu } from "./IssueListFilters";
import { ListSearchInput, type ListFilterOption } from "../sourceControl/ListFilterMenu";
import { IssueRow } from "./IssueRow";
import { IssuesUnavailableState } from "./IssuesUnavailableState";

// The same vocabulary the issues page filters by, minus the two questions a panel already knows
// the answer to: it lists one project, on one host.
const STATE_OPTIONS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "open", label: "Open", Icon: CircleDotIcon },
  { value: "closed", label: "Closed", Icon: CircleCheckIcon },
] as const satisfies ReadonlyArray<ListFilterOption<IssueListState>>;

const INVOLVEMENT_OPTIONS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "assigned", label: "Assigned", Icon: UserCheckIcon },
  { value: "authored", label: "Authored", Icon: PenLineIcon },
  { value: "mentioned", label: "Mentioned", Icon: AtSignIcon },
] as const satisfies ReadonlyArray<ListFilterOption<IssueInvolvement>>;

/** What the panel narrows by, held above the list so reading an issue does not throw it away. */
interface PanelFilters {
  readonly state: IssueListState;
  readonly involvement: IssueInvolvement;
  readonly label: string | undefined;
  readonly sort: IssueListSort;
  readonly order: IssueListOrder;
}

/**
 * Where the next slice carries on from, per repository, as the server handed it back — the same
 * bargain the issues page makes. Sending it is what makes a second page cost a second page rather
 * than the whole list again. Held above the list for the reason the filters are.
 */
interface PanelPage {
  readonly key: string;
  readonly size: number;
  readonly cursors: Record<string, string> | null;
}

const SEARCH_DEBOUNCE_MS = 250;
/**
 * What `IssueListInput` accepts as a query. Past it the read is refused outright, so a pasted wall
 * of text searches its opening rather than coming back as an error about its length.
 */
const MAX_QUERY_LENGTH = 200;
const PAGE_SIZE = 30;
/** The listing's own ceiling. Past it the search is the way to find something, not more rows. */
const MAX_LIMIT = 500;

interface IssuesPanelProps {
  environmentId: EnvironmentId;
  /** The thread's project, which is the only repository this panel lists. */
  projectId: ProjectId;
  selected: IssuesSurface["selected"];
  /** Null returns the panel to the list it was picked from. */
  onSelect: (target: NonNullable<IssuesSurface["selected"]> | null) => void;
  handoffTarget: IssueHandoffTarget;
  onStateChange: (status: IssueTabStatus) => void;
  onOpenLinkedPullRequest: (link: IssueLinkedPullRequest) => void;
}

/**
 * The thread's own issues, beside the conversation. Deliberately not the issues page in a tab: one
 * project, one page, no filters and no URL to keep — everything this needs is the list and the one
 * issue being read, and both live in the same tab.
 *
 * Keyed by the repository it lists, because the panel outlives the thread it was opened beside:
 * a search typed for one project, and how far its list was paged, are no question to ask of the
 * next one.
 */
export function IssuesPanel(props: IssuesPanelProps) {
  return <ProjectIssues key={`${props.environmentId}:${props.projectId}`} {...props} />;
}

function ProjectIssues({
  environmentId,
  projectId,
  selected,
  onSelect,
  handoffTarget,
  onStateChange,
  onOpenLinkedPullRequest,
}: IssuesPanelProps) {
  const projects = useProjects();
  const [actedAt, setActedAt] = useState(0);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<PanelPage>({ key: "", size: PAGE_SIZE, cursors: null });
  const [filters, setFilters] = useState<{
    readonly state: IssueListState;
    readonly involvement: IssueInvolvement;
    readonly label: string | undefined;
    readonly sort: IssueListSort;
    readonly order: IssueListOrder;
  }>({ state: "open", involvement: "all", label: undefined, sort: "updated", order: "desc" });

  return (
    <>
      <IssueBrowserList
        environmentId={environmentId}
        projectId={projectId}
        hidden={selected !== null}
        actedAt={actedAt}
        onSelect={onSelect}
        query={query}
        onQuery={setQuery}
        page={page}
        onPage={setPage}
        filters={filters}
        onFilters={setFilters}
      />
      {selected ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center border-b border-border/50 px-1.5 py-1">
            <Button variant="ghost-muted" size="xs" onClick={() => onSelect(null)}>
              <ArrowLeftIcon className="size-3.5" />
              All issues
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            {/* Hand-offs land in the thread this panel sits beside, so reading an issue and acting
              on it stay one conversation. */}
            <IssueDetailPanel
              key={`${selected.provider ?? ""}:${selected.repository}#${selected.number}`}
              environmentId={environmentId}
              reference={{
                projectId: selected.projectId as ProjectId,
                ...(selected.provider === undefined ? {} : { provider: selected.provider }),
                repository: selected.repository,
                number: selected.number,
              }}
              handoffTarget={handoffTarget}
              onActed={() => setActedAt(Date.now())}
              onStateChange={onStateChange}
              onOpenLinkedPullRequest={onOpenLinkedPullRequest}
              onOpenRelatedIssue={(relative) => {
                const target = relatedIssueTarget(
                  projects.filter((candidate) => candidate.environmentId === environmentId),
                  selected,
                  relative,
                );
                if (target === null) openLinkInBrowser(relative.url);
                else onSelect({ ...selected, ...target });
              }}
              // The panel is the narrowest place this reads, so the metadata folds into the top row
              // once the content scrolls — the same bargain the issues page makes.
              chromeVariant="collapse"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function IssueBrowserList({
  environmentId,
  projectId,
  hidden,
  actedAt,
  onSelect,
  query,
  onQuery,
  page,
  onPage,
  filters,
  onFilters,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  hidden: boolean;
  actedAt: number;
  onSelect: (target: NonNullable<IssuesSurface["selected"]>) => void;
  query: string;
  onQuery: (query: string) => void;
  page: PanelPage;
  onPage: (page: PanelPage) => void;
  filters: PanelFilters;
  onFilters: (filters: PanelFilters) => void;
}) {
  const typed = query.trim().slice(0, MAX_QUERY_LENGTH);
  // Searching asks the host, which takes a round trip, so the text is held for a moment before it
  // is sent — the same bargain the issues page makes.
  const sent = useDebouncedValue(typed, SEARCH_DEBOUNCE_MS);

  // The label is narrowed on the rows rather than on the host, so it is no part of the question
  // and no reason to start the list again.
  const filterKey = `${filters.state}:${filters.involvement}:${filters.sort}:${filters.order}:${sent}`;
  const pageSize = page.key === filterKey ? page.size : PAGE_SIZE;
  const sentCursors = page.key === filterKey ? page.cursors : null;

  // Typing a search, or changing a filter, starts the list again at its first page: the paging
  // state from before belongs to a question nobody is asking any more.
  useEffect(() => {
    onPage({ key: filterKey, size: PAGE_SIZE, cursors: null });
    // Only the question itself starts the list over; `onPage` is the setter and never changes.
  }, [filterKey]);

  const listQuery = useEnvironmentQuery(
    issueEnvironment.list({
      environmentId,
      input: {
        state: filters.state,
        involvement: filters.involvement,
        projectId,
        limit: pageSize,
        sort: filters.sort,
        order: filters.order,
        ...(sent ? { query: sent } : {}),
        ...(sentCursors === null ? {} : { cursors: sentCursors }),
      },
    }),
  );
  const answered = listQuery.data;
  const sortingHosts = answered?.providers ?? [];
  const availableSorts = (sortingHosts[0]?.sorts ?? []).filter((sort) =>
    sortingHosts.every((provider) => provider.sorts.includes(sort)),
  );
  const searchingHosts = useMemo(
    () =>
      new Set(
        (answered?.providers ?? []).flatMap((provider) =>
          provider.searchesOnHost ? [provider.host] : [],
        ),
      ),
    [answered?.providers],
  );

  /**
   * What the list holds, across the slices it has asked for. A continuation carries only the rows
   * that come after the ones already held, so everything on screen stays and the slice — ordered
   * among itself, since one repository's next rows can be newer than another's last — lands under
   * it. A whole-page answer replaces the order outright.
   */
  const [ordered, setOrdered] = useState<{
    key: string;
    entries: ReadonlyArray<IssueListEntry>;
    /** Held with the rows, because a read in flight answers nothing about what is left. */
    truncated: boolean;
    cursorLimitReached: boolean;
    /**
     * Held with the rows for the same reason: who is signed in is what "assigned to me" is judged
     * against, and forgetting it for the length of a continuation would hide every row on screen.
     */
    viewers: IssueViewers;
  } | null>(null);
  useEffect(() => {
    if (answered === null) return;
    const hostOrdered =
      filters.sort === "best-match" &&
      answered.providers.some((provider) => !provider.sorts.includes("best-match"))
        ? rankIssueMatches(answered.entries, sent)
        : answered.entries;
    setOrdered((previous) => {
      if (
        previous === null ||
        previous.key !== filterKey ||
        (sentCursors === null && answered.errors.length === 0)
      ) {
        return {
          key: filterKey,
          entries: hostOrdered,
          truncated: answered.truncated,
          cursorLimitReached: answered.cursorLimitReached === true,
          viewers: answered.viewers,
        };
      }
      const held = new Set(previous.entries.map(issueEntryKey));
      const arrived = answered.entries.filter((entry) => !held.has(issueEntryKey(entry)));
      return {
        key: filterKey,
        entries: [...previous.entries, ...arrived],
        truncated: answered.truncated,
        cursorLimitReached: previous.cursorLimitReached || answered.cursorLimitReached === true,
        viewers: answered.viewers,
      };
    });
  }, [answered, filterKey, filters.order, filters.sort, sent, sentCursors]);

  // Involvement and the label are narrowed here as well as asked for: a host that cannot express
  // "mentioned" answers unnarrowed, and no host is asked about a label at all.
  const entries = useMemo(() => {
    const shown = ordered?.key === filterKey ? ordered : null;
    const held = shown?.entries ?? answered?.entries ?? [];
    const byInvolvement = filterIssuesByInvolvement(
      held,
      shown?.viewers ?? answered?.viewers ?? {},
      filters.involvement,
    );
    const queried = filterIssueQueryResults(
      byInvolvement,
      typed,
      typed === sent && !listQuery.isPending,
      searchingHosts,
    );
    return filters.label === undefined
      ? queried
      : queried.filter((entry) => entry.labels.some((label) => label.name === filters.label));
  }, [
    answered,
    filterKey,
    filters.involvement,
    filters.label,
    listQuery.isPending,
    ordered,
    searchingHosts,
    sent,
    typed,
  ]);

  const heldEntries = ordered?.key === filterKey ? ordered.entries : (answered?.entries ?? []);
  const cursorLimitReached =
    (ordered?.key === filterKey && ordered.cursorLimitReached) ||
    answered?.cursorLimitReached === true;
  /** From what is held rather than from the read in flight, which has not answered yet. */
  const truncated =
    (ordered?.key === filterKey ? ordered.truncated : (answered?.truncated ?? false)) ||
    cursorLimitReached;
  const failure =
    listQuery.error ?? (answered?.errors.map((error) => error.message).join(" ") || null);
  const invalidate = useAtomCommand(issueEnvironment.invalidate, { reportFailure: false });
  const retry = async () => {
    if (listQuery.error === null) await invalidate({ environmentId, input: {} });
    listQuery.refresh();
  };
  /** Rows are on screen and another slice is on its way, which is what the reader is told. */
  const loadingMore = listQuery.isPending && entries.length > 0;

  const nextCursors = answered?.nextCursors ?? {};
  const canContinue = Object.keys(nextCursors).length > 0;
  const canGrow = !cursorLimitReached && pageSize < MAX_LIMIT;
  const loadMore = () => {
    if (canContinue) {
      onPage({ key: filterKey, size: pageSize, cursors: nextCursors });
      return;
    }
    if (!canGrow) return;
    onPage({ key: filterKey, size: Math.min(pageSize + PAGE_SIZE, MAX_LIMIT), cursors: null });
  };

  const appliedActedAt = useRef(actedAt);
  useEffect(() => {
    if (appliedActedAt.current === actedAt) return;
    if (sentCursors !== null) {
      onPage({
        key: filterKey,
        size: Math.min(
          Math.max(pageSize, Math.ceil(heldEntries.length / PAGE_SIZE) * PAGE_SIZE),
          MAX_LIMIT,
        ),
        cursors: null,
      });
      return;
    }
    if (listQuery.isPending) return;
    appliedActedAt.current = actedAt;
    listQuery.refresh();
  }, [actedAt, sentCursors, listQuery.isPending]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    // Rows on screen are what makes reaching the sentinel mean anything: with none it sits under
    // the empty state and is always in view, so a search that matches nothing would page through
    // the whole repository on its own. A failed page stops the observer for the same reason —
    // the rows stay, so re-arming would ask again forever.
    if (
      !sentinel ||
      hidden ||
      entries.length === 0 ||
      !truncated ||
      listQuery.isPending ||
      failure !== null ||
      // Asking past the ceiling is refused, and a continuation does not grow the page at all,
      // so the ceiling only stops the growth path.
      (!canContinue && !canGrow)
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) loadMore();
      },
      // Start the next slice slightly before the sentinel is on screen.
      { rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // `loadMore` is rebuilt every render and reads only what is listed here.
  }, [
    hidden,
    truncated,
    canContinue,
    canGrow,
    entries.length,
    failure,
    filterKey,
    listQuery.isPending,
    pageSize,
  ]);

  // Said apart from "there are none": a filter hiding every row is a different answer from a
  // repository with nothing in it, and only one of them is worth widening a filter over.
  const narrowed =
    filters.state !== "open" || filters.involvement !== "all" || filters.label !== undefined;

  /** Offered from what arrived: a label nothing here wears would narrow the list to nothing. */
  const labelOptions = useMemo(() => {
    const names = new Set(heldEntries.flatMap((entry) => entry.labels.map((label) => label.name)));
    if (filters.label !== undefined) names.add(filters.label);
    return [...names].sort((left, right) => left.localeCompare(right));
  }, [filters.label, heldEntries]);

  // Stable, because the rows are memoized on it.
  const select = useCallback(
    (entry: IssueListEntry) =>
      onSelect({
        projectId,
        provider: entry.provider,
        repository: entry.repository,
        number: entry.number,
      }),
    [onSelect, projectId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" hidden={hidden}>
      <div className="flex items-center gap-2 px-2 py-2">
        <ListSearchInput
          label="Search issues"
          value={query}
          busy={typed.length > 0 && (typed !== sent || listQuery.isPending)}
          onChange={onQuery}
        />
        <div className="flex shrink-0 items-center gap-1">
          <IssueSortMenu
            sorts={availableSorts}
            sort={filters.sort}
            order={filters.order}
            onSort={(sort) => onFilters({ ...filters, sort })}
            onOrder={(order) => onFilters({ ...filters, order })}
          />
          <IssueFiltersMenu
            state={filters.state}
            stateOptions={STATE_OPTIONS}
            onState={(state) => onFilters({ ...filters, state })}
            involvement={filters.involvement}
            involvementOptions={INVOLVEMENT_OPTIONS}
            onInvolvement={(involvement) => onFilters({ ...filters, involvement })}
            label={filters.label}
            labels={labelOptions}
            onLabel={(label) => onFilters({ ...filters, label })}
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 px-1 pb-2">
          {entries.length === 0 && listQuery.isPending ? (
            <ListGhost rows={7} label="Loading issues" />
          ) : failure !== null && heldEntries.length === 0 ? (
            <IssuesUnavailableState
              error={failure}
              refreshing={listQuery.isPending}
              onRetry={() => void retry()}
            />
          ) : entries.length === 0 ? (
            <div className="space-y-2 px-2">
              <p className="text-sm text-muted-foreground">
                {typed.length > 0
                  ? "No issue here matches that."
                  : narrowed
                    ? "No issue here matches these filters."
                    : "This repository has no issues to open."}
              </p>
              {/* The filters narrow the rows that arrived, so a page they empty says nothing about
                  the pages after it. Asked for by hand rather than by the sentinel: with no rows
                  to scroll past, scrolling would read the whole repository on its own. */}
              {failure === null && truncated && (canContinue || canGrow) ? (
                <Button variant="outline" size="xs" onClick={loadMore}>
                  Load more
                </Button>
              ) : cursorLimitReached && !canContinue ? (
                <p className="text-xs text-muted-foreground">More issues remain on the host.</p>
              ) : null}
            </div>
          ) : (
            <>
              {entries.map((entry) => (
                <IssueRow
                  key={issueEntryKey(entry)}
                  entry={entry}
                  selected={false}
                  showProjectTitle={false}
                  showProvider={false}
                  reactionSort={filters.sort}
                  onSelect={select}
                />
              ))}
              {/* Scrolling to here asks for the next slice; it says so only while one is on the
                  way, so a list that has run out ends on its last row rather than on a label. */}
              {truncated ? (
                <div
                  ref={sentinelRef}
                  className="flex justify-center py-2 text-xs text-muted-foreground"
                >
                  {loadingMore ? (
                    <span className="flex items-center gap-2">
                      <Spinner aria-hidden size="sm" />
                      Loading more
                    </span>
                  ) : cursorLimitReached && !canContinue ? (
                    "More issues remain on the host."
                  ) : null}
                </div>
              ) : null}
            </>
          )}
          {failure !== null && heldEntries.length > 0 ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-xs">
              <span>{failure} Showing the last issues loaded.</span>
              <Button size="xs" variant="outline" onClick={() => void retry()}>
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

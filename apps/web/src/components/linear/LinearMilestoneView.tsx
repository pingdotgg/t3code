import type { LinearMilestone, LinearViewer } from "@t3tools/contracts";
import { LockIcon } from "lucide-react";
import type { Ref } from "react";

import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { LinearBanner } from "./LinearBanner";
import { LinearFilters } from "./LinearFilters";
import { LinearIssueList } from "./LinearIssueList";
import type { LinearIssueRowContext } from "./LinearIssueRow";
import { LinearProgressSummary } from "./LinearLevels";
import {
  clearLinearFilters,
  hasActiveLinearFilters,
  linearIssueFilter,
  NO_MILESTONE_ID,
  T3_ACTIVITY_VIEW,
  DEFAULT_LINEAR_GROUP,
  type LinearSearch,
  type LinearSearchPatch,
} from "./linearSearch";
import {
  useLinearDegradation,
  useLinearIssues,
  useLinearRefresh,
  useLinearTeamMetadata,
  useLinearViews,
} from "./useLinearData";

const EMPTY_VIEWS: ReadonlyArray<never> = [];
const SKELETON_ROWS = ["a", "b", "c", "d", "e"] as const;

/** Milestone level: header, filters, saved views, and the grouped issue list. */
export function LinearMilestoneView({
  search,
  milestone,
  activityIssueIds,
  viewer,
  rowContext,
  searchInputRef,
  onSearchChange,
  onReplaceSearch,
}: {
  search: LinearSearch;
  milestone: LinearMilestone | undefined;
  activityIssueIds: ReadonlyArray<string>;
  viewer: LinearViewer | null;
  rowContext: LinearIssueRowContext;
  searchInputRef: Ref<HTMLInputElement>;
  onSearchChange: (patch: LinearSearchPatch) => void;
  onReplaceSearch: (next: LinearSearch) => void;
}) {
  const metadata = useLinearTeamMetadata(search.team);
  const views = useLinearViews();
  const t3View = search.view === T3_ACTIVITY_VIEW;
  // "Has T3 activity" with nothing linked yet is empty by definition; an empty id list is not
  // "no restriction" to the server, so it never gets asked.
  const noActivity = t3View && activityIssueIds.length === 0;
  const filter = noActivity ? null : linearIssueFilter(search, { activityIssueIds });
  const issues = useLinearIssues(filter);
  const { refresh, refreshing } = useLinearRefresh();
  const degradation = useLinearDegradation(
    [issues.failure, metadata.failure, views.failure],
    issues.data?.stale === true,
  );
  const statePositions = new Map(
    (metadata.data?.states ?? []).map((state) => [state.id, state.position]),
  );
  const result = noActivity ? { issues: [], truncated: false } : issues.data;
  const isNoMilestone = search.milestone === NO_MILESTONE_ID;
  const completedHidden = search.showCompleted !== true && (search.states?.length ?? 0) === 0;
  return (
    <div className="flex flex-col gap-3">
      {degradation ? (
        <LinearBanner degradation={degradation} onRetry={refresh} retrying={refreshing} />
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="m-0 flex items-center gap-2 text-base font-semibold tracking-tight">
            {isNoMilestone ? "No milestone" : (milestone?.name ?? "Milestone")}
          </h2>
          {milestone ? (
            <LinearProgressSummary
              progress={milestone.progress}
              issueCount={milestone.issueCount}
              targetDate={milestone.targetDate}
            />
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled
          title="Launching a chat per sub-issue is coming later"
        >
          <LockIcon aria-hidden />
          Launch for sub-issues…
          <span className="rounded border border-dashed border-border px-1 text-3xs font-semibold tracking-wide text-muted-foreground">
            LATER
          </span>
        </Button>
      </div>
      <LinearFilters
        search={search}
        metadata={metadata.data}
        views={views.data ?? EMPTY_VIEWS}
        viewer={viewer}
        searchInputRef={searchInputRef}
        onSearchChange={onSearchChange}
      />
      {result === null ? (
        issues.error === null ? (
          <div className="flex flex-col gap-2" aria-busy>
            {SKELETON_ROWS.map((row) => (
              <Skeleton key={row} className="h-10 w-full" shape="card" />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2 py-6 text-sm text-muted-foreground">
            <p className="m-0">Couldn&apos;t load issues.</p>
            <Button variant="outline" size="sm" onClick={issues.refresh}>
              Retry
            </Button>
          </div>
        )
      ) : result.issues.length === 0 ? (
        <div className="flex flex-col items-start gap-2 py-6 text-sm text-muted-foreground">
          <p className="m-0">
            {completedHidden
              ? "No open issues match. Completed issues are hidden."
              : "No issues match."}
          </p>
          {completedHidden ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReplaceSearch({ ...search, showCompleted: true })}
            >
              Show completed
            </Button>
          ) : null}
          {hasActiveLinearFilters(search) ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReplaceSearch(clearLinearFilters(search))}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <LinearIssueList
            issues={result.issues}
            groupBy={search.group ?? DEFAULT_LINEAR_GROUP}
            statePositions={statePositions}
            context={rowContext}
          />
          {result.truncated ? (
            <p className="m-0 text-center text-xs text-muted-foreground">
              Showing first 250 issues. Narrow the filters to see the rest.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

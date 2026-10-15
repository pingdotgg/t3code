import type { Preferences, PullRequestSavedView } from "../../persistence/mobile-preferences";

export type PullRequestSavedViewScope = Pick<
  PullRequestSavedView,
  "environmentId" | "controls" | "query"
>;

export function pullRequestViewMatches(
  view: PullRequestSavedView,
  scope: PullRequestSavedViewScope,
) {
  const key = ({ environmentId, controls, query }: PullRequestSavedViewScope) =>
    JSON.stringify([
      environmentId,
      query.trim(),
      controls.state,
      controls.involvement,
      controls.sort,
      controls.projectId,
      controls.projectEnvironmentId,
      controls.filters.draft,
      controls.filters.review,
      controls.filters.checks,
      controls.filters.author,
      controls.filters.labels
        ?.map((group) => [...group].sort())
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      controls.filters.excludedLabels ? [...controls.filters.excludedLabels].sort() : undefined,
    ]);
  return key(view) === key(scope);
}

/** Apply environment and controls in one preference write, retaining other environments' controls. */
export function pullRequestSavedViewPreferences(current: Preferences, view: PullRequestSavedView) {
  return {
    pullRequestListFilters: {
      environmentId: view.environmentId,
      controls: {
        ...current.pullRequestListFilters?.controls,
        [view.environmentId ?? ""]: view.controls,
      },
    },
  };
}

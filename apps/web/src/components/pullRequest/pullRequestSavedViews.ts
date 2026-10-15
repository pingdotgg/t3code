import * as Schema from "effect/Schema";
import { PullRequestSavedViewIdentity } from "@t3tools/client-runtime/pull-request-saved-views";

import {
  pullRequestListPreferences,
  PullRequestListPreferencesSchema,
  type PullRequestListPreferencePatch,
  type PullRequestListPreferences,
} from "./pullRequestListPreferences";

export const PULL_REQUEST_SAVED_VIEWS_KEY = "t3.pullRequests.savedViews";

export const PullRequestSavedViews = Schema.Array(
  Schema.Struct({
    ...PullRequestSavedViewIdentity.fields,
    preferences: PullRequestListPreferencesSchema,
  }),
);
export type PullRequestSavedView = (typeof PullRequestSavedViews.Type)[number];
export const EMPTY_PULL_REQUEST_SAVED_VIEWS: typeof PullRequestSavedViews.Type = [];

export function pullRequestViewMatches(
  view: PullRequestSavedView,
  preferences: PullRequestListPreferences,
): boolean {
  const key = (value: PullRequestListPreferences) => {
    const normalized = pullRequestListPreferences(value);
    return JSON.stringify({
      ...normalized,
      labels: normalized.labels?.toSorted(),
    });
  };
  return key(pullRequestListPreferences(view.preferences)) === key(preferences);
}

/** Explicit clears replace the old list scope without touching the independently selected PR. */
export function pullRequestSavedViewPatch(
  preferences: PullRequestListPreferences,
): PullRequestListPreferencePatch & Pick<PullRequestListPreferences, "involvement" | "state"> {
  return {
    involvement: preferences.involvement,
    state: preferences.state,
    environmentId: preferences.environmentId,
    projectId: preferences.projectId,
    host: preferences.host,
    q: preferences.q,
    draft: preferences.draft,
    review: preferences.review,
    checks: preferences.checks,
    author: preferences.author,
    labels: preferences.labels,
    sort: preferences.sort,
  };
}

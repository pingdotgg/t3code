import * as Schema from "effect/Schema";
import { msg } from "gt-react";
import { SavedViewIdentity } from "@t3tools/client-runtime/saved-views";

import type { SavedView, SavedViewsKind } from "../SavedViewsMenu";
import {
  pullRequestListPreferences,
  PullRequestListPreferencesSchema,
  type PullRequestListPreferencePatch,
  type PullRequestListPreferences,
} from "./pullRequestListPreferences";

export function pullRequestViewMatches(
  view: SavedView<typeof PullRequestListPreferencesSchema.Type>,
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

export const PULL_REQUEST_SAVED_VIEWS = {
  storageKey: "t3.pullRequests.savedViews",
  schema: Schema.Array(
    Schema.Struct({ ...SavedViewIdentity.fields, preferences: PullRequestListPreferencesSchema }),
  ),
  empty: [],
  list: "pullRequest",
  placeholder: msg("PRs Requesting My Review"),
  suggestedName: (preferences) =>
    preferences.involvement === "reviewing" ? msg("PRs Requesting My Review") : "",
  normalize: pullRequestListPreferences,
  matches: pullRequestViewMatches,
} as const satisfies SavedViewsKind<
  PullRequestListPreferences,
  typeof PullRequestListPreferencesSchema.Type,
  unknown
>;

/** Explicit clears replace the old list scope without touching the independently selected PR. */
export function pullRequestSavedViewPatch(
  preferences: PullRequestListPreferences,
): PullRequestListPreferencePatch & Pick<PullRequestListPreferences, "involvement" | "state"> {
  return {
    involvement: preferences.involvement,
    state: preferences.state,
    environmentId: preferences.environmentId,
    projectId: preferences.projectId,
    projectEnvironmentId: preferences.projectEnvironmentId,
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

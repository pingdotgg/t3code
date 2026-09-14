import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListState,
} from "@t3tools/contracts";

export const PullRequestListSort = Schema.Literals([
  "ready",
  "updated",
  "newest",
  "oldest",
  "largest",
  "smallest",
]);
export type PullRequestListSort = typeof PullRequestListSort.Type;

export interface PullRequestListPreferences {
  readonly involvement: PullRequestInvolvement;
  readonly state: PullRequestListState;
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly host?: string;
  readonly q?: string;
  readonly draft?: "only" | "hide";
  readonly review?: NonNullable<PullRequestListFilters["review"]>;
  readonly checks?: NonNullable<PullRequestListFilters["checks"]>;
  readonly author?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly sort?: PullRequestListSort;
}

export type PullRequestListPreferencePatch = {
  [Key in keyof PullRequestListPreferences]?: PullRequestListPreferences[Key] | undefined;
};

const DEFAULT_PULL_REQUEST_LIST_PREFERENCES = {
  involvement: "all",
  state: "open",
} as const satisfies PullRequestListPreferences;

const BoundedPreference = Schema.String.check(Schema.isMaxLength(200));
const PullRequestListPreferencesSchema = Schema.Struct({
  involvement: PullRequestInvolvement,
  state: PullRequestListState,
  environmentId: Schema.optional(EnvironmentId),
  projectId: Schema.optional(ProjectId),
  host: Schema.optional(BoundedPreference),
  q: Schema.optional(BoundedPreference),
  draft: PullRequestListFilters.fields.draft,
  review: PullRequestListFilters.fields.review,
  checks: PullRequestListFilters.fields.checks,
  author: Schema.optional(BoundedPreference),
  labels: Schema.optional(Schema.Array(BoundedPreference).check(Schema.isMaxLength(10))),
  sort: Schema.optional(PullRequestListSort),
});

const decodePullRequestListPreferences = Schema.decodeUnknownOption(
  PullRequestListPreferencesSchema,
);
const PULL_REQUEST_LIST_PREFERENCES_STORAGE_KEY = "t3.pullRequests.preferences";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function resolvePreferenceStorage(
  storage: PreferenceStorage | undefined,
): PreferenceStorage | undefined {
  return storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
}

/** Only list controls are remembered. The selected row remains a URL and right-panel concern. */
export function pullRequestListPreferences(
  search: PullRequestListPreferences | Schema.Schema.Type<typeof PullRequestListPreferencesSchema>,
): PullRequestListPreferences {
  return {
    involvement: search.involvement,
    state: search.state,
    ...(search.environmentId ? { environmentId: search.environmentId } : {}),
    ...(search.projectId ? { projectId: search.projectId } : {}),
    ...(search.host ? { host: search.host } : {}),
    ...(search.q ? { q: search.q } : {}),
    ...(search.draft ? { draft: search.draft } : {}),
    ...(search.review ? { review: search.review } : {}),
    ...(search.checks ? { checks: search.checks } : {}),
    ...(search.author ? { author: search.author } : {}),
    ...(search.labels && search.labels.length > 0 ? { labels: search.labels } : {}),
    ...(search.sort && search.sort !== "ready" ? { sort: search.sort } : {}),
  };
}

export function readPullRequestListPreferences(
  storage?: PreferenceStorage,
): PullRequestListPreferences {
  try {
    const raw = resolvePreferenceStorage(storage)?.getItem(
      PULL_REQUEST_LIST_PREFERENCES_STORAGE_KEY,
    );
    if (!raw) return DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
    const decoded = decodePullRequestListPreferences(JSON.parse(raw));
    return decoded._tag === "Some"
      ? pullRequestListPreferences(decoded.value)
      : DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
  } catch {
    return DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
  }
}

export function writePullRequestListPreferences(
  preferences: PullRequestListPreferences,
  storage?: PreferenceStorage,
): void {
  try {
    resolvePreferenceStorage(storage)?.setItem(
      PULL_REQUEST_LIST_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // Storage can be full or denied; the URL remains the source of truth for this visit.
  }
}

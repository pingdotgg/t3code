import * as Schema from "effect/Schema";

import { EnvironmentId, IssueInvolvement, IssueListState, ProjectId } from "@t3tools/contracts";

/**
 * What the issues page remembers between visits; the selection in the URL is not part of it.
 * `who` and `status` rather than `involvement` and `state`: the router merges every route's
 * search into one type for `navigate`, and sharing the pull-request page's key names would widen
 * its own literal unions with this page's values.
 */
export interface IssueListPreferences {
  readonly who: IssueInvolvement;
  readonly status: IssueListState;
  readonly issueServer?: EnvironmentId | undefined;
  readonly issueProject?: ProjectId | undefined;
  readonly host?: string | undefined;
  readonly q?: string | undefined;
  /** `label`, `assignee` and `order` for the same reason: the pull-request page has `labels` and `sort`. */
  readonly label?: ReadonlyArray<string> | undefined;
  readonly assignee?: string | undefined;
  readonly order?: "created" | undefined;
}

const DEFAULT_ISSUE_LIST_PREFERENCES = {
  who: "all",
  status: "open",
} as const satisfies IssueListPreferences;

const STORAGE_KEY = "t3.issues.preferences";

const BoundedPreference = Schema.String.check(Schema.isMaxLength(200));
export const IssueListPreferencesSchema = Schema.Struct({
  who: IssueInvolvement,
  status: IssueListState,
  issueServer: Schema.optional(EnvironmentId),
  issueProject: Schema.optional(ProjectId),
  host: Schema.optional(BoundedPreference),
  q: Schema.optional(BoundedPreference),
  label: Schema.optional(Schema.Array(BoundedPreference).check(Schema.isMaxLength(20))),
  assignee: Schema.optional(BoundedPreference),
  order: Schema.optional(Schema.Literal("created")),
});
const decodePreferences = Schema.decodeUnknownOption(IssueListPreferencesSchema);

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function storage(): PreferenceStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** Only list controls are remembered. The selected issue remains a URL and right-panel concern. */
export function issueListPreferences(search: {
  readonly who: IssueInvolvement;
  readonly status: IssueListState;
  readonly issueServer?: EnvironmentId | undefined;
  readonly issueProject?: ProjectId | undefined;
  readonly host?: string | undefined;
  readonly q?: string | undefined;
  readonly label?: ReadonlyArray<string> | undefined;
  readonly assignee?: string | undefined;
  readonly order?: "created" | undefined;
}): IssueListPreferences {
  return {
    who: search.who,
    status: search.status,
    ...(search.issueServer && search.issueProject
      ? { issueServer: search.issueServer, issueProject: search.issueProject }
      : {}),
    ...(search.host ? { host: search.host } : {}),
    ...(search.q ? { q: search.q } : {}),
    ...(search.label?.length ? { label: search.label } : {}),
    ...(search.assignee ? { assignee: search.assignee } : {}),
    ...(search.order ? { order: search.order } : {}),
  };
}

export function readIssueListPreferences(): IssueListPreferences {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ISSUE_LIST_PREFERENCES;
    const decoded = decodePreferences(JSON.parse(raw));
    return decoded._tag === "Some"
      ? issueListPreferences(decoded.value)
      : DEFAULT_ISSUE_LIST_PREFERENCES;
  } catch {
    return DEFAULT_ISSUE_LIST_PREFERENCES;
  }
}

export function writeIssueListPreferences(preferences: IssueListPreferences): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(issueListPreferences(preferences)));
  } catch {
    // Storage can be full or forbidden; the page still works with defaults.
  }
}

import * as Schema from "effect/Schema";

import { IssueInvolvement, IssueListState } from "@t3tools/contracts";

/**
 * What the issues page remembers between visits; the selection in the URL is not part of it.
 * `who` and `status` rather than `involvement` and `state`: the router merges every route's
 * search into one type for `navigate`, and sharing the pull-request page's key names would widen
 * its own literal unions with this page's values.
 */
export interface IssueListPreferences {
  readonly who: IssueInvolvement;
  readonly status: IssueListState;
  readonly host?: string;
  readonly q?: string | undefined;
}

const DEFAULT_ISSUE_LIST_PREFERENCES = {
  who: "all",
  status: "open",
} as const satisfies IssueListPreferences;

const STORAGE_KEY = "t3.issues.preferences";

const BoundedPreference = Schema.String.check(Schema.isMaxLength(200));
const IssueListPreferencesSchema = Schema.Struct({
  who: IssueInvolvement,
  status: IssueListState,
  host: Schema.optional(BoundedPreference),
  q: Schema.optional(BoundedPreference),
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
  readonly host?: string | undefined;
  readonly q?: string | undefined;
}): IssueListPreferences {
  return {
    who: search.who,
    status: search.status,
    ...(search.host ? { host: search.host } : {}),
    ...(search.q ? { q: search.q } : {}),
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

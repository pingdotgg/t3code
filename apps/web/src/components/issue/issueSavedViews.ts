import * as Schema from "effect/Schema";
import { SavedViewIdentity } from "@t3tools/client-runtime/saved-views";

import type { SavedView, SavedViewsKind } from "../SavedViewsMenu";
import {
  issueListPreferences,
  IssueListPreferencesSchema,
  type IssueListPreferences,
} from "./issueListPreferences";

export function issueViewMatches(
  view: SavedView<typeof IssueListPreferencesSchema.Type>,
  preferences: IssueListPreferences,
): boolean {
  const key = (value: IssueListPreferences) => {
    const normalized = issueListPreferences(value);
    return JSON.stringify({
      ...normalized,
      label: normalized.label?.toSorted(),
      project: normalized.project?.toSorted(),
    });
  };
  return key(issueListPreferences(view.preferences)) === key(preferences);
}

export const ISSUE_SAVED_VIEWS = {
  storageKey: "t3.issues.savedViews",
  schema: Schema.Array(
    Schema.Struct({ ...SavedViewIdentity.fields, preferences: IssueListPreferencesSchema }),
  ),
  empty: [],
  noun: "issue",
  shortNoun: "issue",
  placeholder: "Issues Assigned to Me",
  suggestedName: (preferences) => (preferences.who === "assigned" ? "Issues Assigned to Me" : ""),
  normalize: issueListPreferences,
  matches: issueViewMatches,
} as const satisfies SavedViewsKind<
  IssueListPreferences,
  typeof IssueListPreferencesSchema.Type,
  unknown
>;

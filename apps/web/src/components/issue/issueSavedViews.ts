import * as Schema from "effect/Schema";
import { msg } from "gt-react";
import { SavedViewIdentity } from "@t3tools/client-runtime/saved-views";
import { canonicalIssueLabels } from "@t3tools/client-runtime/state/issues";

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
      label: normalized.label === undefined ? undefined : canonicalIssueLabels(normalized.label),
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
  list: "issue",
  placeholder: msg("Issues Assigned to Me"),
  suggestedName: (preferences) =>
    preferences.who === "assigned" ? msg("Issues Assigned to Me") : "",
  normalize: issueListPreferences,
  matches: issueViewMatches,
} as const satisfies SavedViewsKind<
  IssueListPreferences,
  typeof IssueListPreferencesSchema.Type,
  unknown
>;

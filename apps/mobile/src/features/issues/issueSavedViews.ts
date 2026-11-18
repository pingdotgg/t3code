import { canonicalIssueLabels } from "@t3tools/client-runtime/state/issues";

import type { IssueSavedView } from "../../persistence/mobile-preferences";

export type IssueSavedViewScope = Omit<IssueSavedView, "id" | "name">;

export function issueViewMatches(view: IssueSavedViewScope, scope: IssueSavedViewScope) {
  const key = (value: IssueSavedViewScope) =>
    JSON.stringify([
      value.query.trim(),
      value.state,
      value.involvement,
      value.sort,
      canonicalIssueLabels(value.labels),
      value.assignee?.login ?? null,
    ]);
  return key(view) === key(scope);
}

import type { IssueSavedView } from "../../persistence/mobile-preferences";

export type IssueSavedViewScope = Omit<IssueSavedView, "id" | "name">;

export function issueViewMatches(view: IssueSavedViewScope, scope: IssueSavedViewScope) {
  const key = (value: IssueSavedViewScope) =>
    JSON.stringify([
      value.query.trim(),
      value.state,
      value.involvement,
      value.sort,
      [...value.labels].sort(),
      value.assignee?.login ?? null,
    ]);
  return key(view) === key(scope);
}

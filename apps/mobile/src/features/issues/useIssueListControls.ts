import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import type { IssueListFilters } from "../../persistence/mobile-preferences";
import { useProjects } from "../../state/entities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { issueListControlsFor } from "./issueList";

export function useIssueListControls() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const environments = useWorkspaceEnvironments();
  const projects = useProjects();
  const saved = AsyncResult.isSuccess(preferences) ? preferences.value.issueListFilters : undefined;
  const controls = issueListControlsFor(
    saved,
    environments.map((environment) => environment.environmentId),
    projects,
  );
  const setControls = useCallback(
    (next: IssueListFilters) => savePreferences({ issueListFilters: next }),
    [savePreferences],
  );
  return { controls, setControls };
}

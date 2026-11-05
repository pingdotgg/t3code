import { useAtomSet } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig } from "../../state/entities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useRememberThreadProject(project: EnvironmentProject | null) {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const serverConfig = useEnvironmentServerConfig(project?.environmentId ?? null);
  const environmentId = project?.environmentId;
  const projectId = project?.id;
  const remember =
    project !== null &&
    serverConfig !== null &&
    !isScratchProject(project, serverConfig.scratchWorkspaceRoot);

  useFocusEffect(
    useCallback(() => {
      if (!remember || !environmentId || !projectId) return;
      const preferences = appAtomRegistry.get(mobilePreferencesAtom);
      if (!AsyncResult.isSuccess(preferences)) return;
      const last = preferences.value.lastThreadProject;
      if (last?.environmentId === environmentId && last.projectId === projectId) return;
      savePreferences({ lastThreadProject: { environmentId, projectId } });
    }, [environmentId, projectId, remember, savePreferences]),
  );
}

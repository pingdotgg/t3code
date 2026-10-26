import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useCallback, type Dispatch, type SetStateAction } from "react";

import { useProjects, useServerConfigs } from "../../state/entities";
import { createDraft, scheduledTaskDefaultModel } from "./scheduledTaskDraft";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { settingsTargetsForProject } from "./settings-environment-filter.logic";

import {
  scheduledTaskEditorHasChanges,
  scheduledTaskEditorSessionAtom,
  startScheduledTaskEditor,
  updateScheduledTaskEditor,
  readScheduledTaskEditor,
  type ScheduledTaskEditor,
} from "./scheduled-task-editor-state";

/** The form draft lives in an atom, so it survives while its native picker routes are on top. */
export function useScheduledTaskEditor() {
  const { selectedTargets, selectedProjectKey, projectGroups } = useSettingsEnvironmentFilter();
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const configs = useServerConfigs();
  const projects = useProjects();
  const defaultTarget = settingsTargetsForProject(
    selectedTargets,
    selectedProjectKey === null ? null : selectedGroup,
  )[0];
  const draftForEnvironment = useCallback(
    (environmentId: EnvironmentId) => {
      const environmentProjects = projects.filter(
        (project) => project.environmentId === environmentId,
      );
      const project =
        environmentProjects.find((project) =>
          selectedGroup?.members.some(
            (member) =>
              member.project.environmentId === environmentId && member.project.id === project.id,
          ),
        ) ?? environmentProjects[0];
      return createDraft(
        project?.id ?? null,
        scheduledTaskDefaultModel(configs.get(environmentId) ?? null, project ?? null),
      );
    },
    [configs, projects, selectedGroup],
  );
  // Direct links can open the new-task form before environments have connected.
  const defaultEditor = useMemo(
    () =>
      defaultTarget
        ? {
            environmentId: defaultTarget.environmentId,
            environmentLabel: defaultTarget.label,
            draft: draftForEnvironment(defaultTarget.environmentId),
          }
        : null,
    [defaultTarget, draftForEnvironment],
  );
  const session = useAtomValue(scheduledTaskEditorSessionAtom);
  const voiceOwnerKey = `scheduled-task:${session?.id ?? 0}`;
  const editor = session ? session.current : defaultEditor;
  const initial = session ? session.initial : defaultEditor;
  const hasChanges = scheduledTaskEditorHasChanges(initial, editor);
  const setEditor = useCallback<Dispatch<SetStateAction<ScheduledTaskEditor | null>>>(
    (update) => {
      updateScheduledTaskEditor(update, defaultEditor);
    },
    [defaultEditor],
  );
  const startEditor = startScheduledTaskEditor;
  const resetEditor = useCallback(() => startEditor(defaultEditor), [defaultEditor]);
  const readEditor = useCallback(
    () => readScheduledTaskEditor(voiceOwnerKey, defaultEditor),
    [defaultEditor, voiceOwnerKey],
  );
  return useMemo(
    () => ({
      editor,
      voiceOwnerKey,
      readEditor,
      setEditor,
      startEditor,
      hasChanges,
      resetEditor,
      draftForEnvironment,
    }),
    [editor, voiceOwnerKey, readEditor, setEditor, hasChanges, resetEditor, draftForEnvironment],
  );
}

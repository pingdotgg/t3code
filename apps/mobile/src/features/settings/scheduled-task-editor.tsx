import type { EnvironmentId } from "@t3tools/contracts";
import {
  createContext,
  use,
  useMemo,
  useCallback,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import { buildModelOptions } from "../../lib/modelOptions";
import { useProjects, useServerConfigs } from "../../state/entities";
import {
  createDraft,
  hasScheduledTaskDraftChanges,
  type ScheduledTaskDraft,
} from "./scheduledTaskDraft";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

type ScheduledTaskEditor = {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly draft: ScheduledTaskDraft;
};

const ScheduledTaskEditorContext = createContext<{
  readonly editor: ScheduledTaskEditor | null;
  readonly setEditor: Dispatch<SetStateAction<ScheduledTaskEditor | null>>;
  readonly startEditor: (editor: ScheduledTaskEditor | null) => void;
  readonly hasChanges: boolean;
  readonly resetEditor: () => void;
  readonly draftForEnvironment: (environmentId: EnvironmentId) => ScheduledTaskDraft;
} | null>(null);

/** Keeps the form draft alive while its native picker routes are on top. */
export function ScheduledTaskEditorProvider({ children }: { readonly children: ReactNode }) {
  const { availableTargets, selectedTargets, selectedProjectKey, projectGroups } =
    useSettingsEnvironmentFilter();
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const configs = useServerConfigs();
  const projects = useProjects();
  const defaultTarget =
    selectedTargets.find(
      (target) =>
        selectedProjectKey === null ||
        selectedGroup?.members.some(
          (member) => member.project.environmentId === target.environmentId,
        ),
    ) ?? availableTargets[0];
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
        buildModelOptions(configs.get(environmentId) ?? null, null)[0]?.selection ?? null,
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
  const [session, setSession] = useState<{
    readonly initial: ScheduledTaskEditor | null;
    readonly current: ScheduledTaskEditor | null;
  } | null>(null);
  const editor = session?.current ?? defaultEditor;
  const initial = session?.initial ?? defaultEditor;
  const hasChanges = Boolean(
    initial &&
    editor &&
    (initial.environmentId !== editor.environmentId ||
      hasScheduledTaskDraftChanges(initial.draft, editor.draft)),
  );
  const setEditor = useCallback<Dispatch<SetStateAction<ScheduledTaskEditor | null>>>(
    (update) => {
      setSession((current) => {
        const previous = current?.current ?? defaultEditor;
        return {
          initial: current?.initial ?? previous,
          current: typeof update === "function" ? update(previous) : update,
        };
      });
    },
    [defaultEditor],
  );
  const startEditor = useCallback((next: ScheduledTaskEditor | null) => {
    setSession({ initial: next, current: next });
  }, []);
  const resetEditor = useCallback(() => startEditor(defaultEditor), [defaultEditor, startEditor]);
  const value = useMemo(
    () => ({ editor, setEditor, startEditor, hasChanges, resetEditor, draftForEnvironment }),
    [editor, setEditor, startEditor, hasChanges, resetEditor, draftForEnvironment],
  );
  return <ScheduledTaskEditorContext value={value}>{children}</ScheduledTaskEditorContext>;
}

export function useScheduledTaskEditor() {
  const context = use(ScheduledTaskEditorContext);
  if (!context) throw new Error("Scheduled task editor provider is missing.");
  return context;
}

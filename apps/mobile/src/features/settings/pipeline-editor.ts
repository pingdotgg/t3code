import { useAtomValue } from "@effect/atom-react";
import {
  emptyPipelineDraft,
  hasPipelineDraftChanges,
  starterToDraft,
  type PipelineDraft,
  type PipelineStepDefaults,
} from "@t3tools/client-runtime/pipeline-editor";
import { DEFAULT_SERVER_SETTINGS, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import type { PipelineStarter } from "@t3tools/shared/pipelineStarters";
import { Atom } from "effect/reactivity";
import { useCallback, useMemo, type Dispatch, type SetStateAction } from "react";

import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useServerConfigs } from "../../state/entities";
import { buildModelOptions } from "../../lib/modelOptions";
import { scheduledTaskDefaultModel } from "./scheduledTaskDraft";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export type PipelineEditor = {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly draft: PipelineDraft;
  /** The step whose model the native picker route is editing. */
  readonly modelStepId: string | null;
};

type PipelineEditorSession = {
  readonly initial: PipelineEditor | null;
  readonly current: PipelineEditor | null;
};

/** The form draft lives in an atom, so it survives while its native picker route is on top. */
export const pipelineEditorSessionAtom = Atom.make<PipelineEditorSession | null>(null).pipe(
  Atom.keepAlive,
);

/** The provider instances a pipeline step can run on in `config`'s environment. */
export function pipelineAvailableInstanceIds(config: ServerConfig | null): ReadonlySet<string> {
  return new Set(
    buildModelOptions(config, null, undefined, null).flatMap((option) =>
      option.isUnavailable ? [] : [option.selection.instanceId],
    ),
  );
}

export function pipelineStepDefaults(config: ServerConfig | null): PipelineStepDefaults {
  return {
    modelSelection: scheduledTaskDefaultModel(config, null),
    runtimeMode: (config?.settings ?? DEFAULT_SERVER_SETTINGS).defaultRuntimeMode,
  };
}

export function pipelineTargetSupportsPipelines(target: SettingsTarget): boolean {
  return target.serverConfig.environment.capabilities.pipelines === true;
}

function pipelineEditorHasChanges(initial: PipelineEditor | null, current: PipelineEditor | null) {
  return Boolean(
    initial &&
    current &&
    (initial.environmentId !== current.environmentId ||
      hasPipelineDraftChanges(initial.draft, current.draft)),
  );
}

export function startPipelineEditor(next: PipelineEditor | null): void {
  appAtomRegistry.set(pipelineEditorSessionAtom, { initial: next, current: next });
}

/** A saved pipeline is the new baseline, so the removal guard stops treating edits as unsaved. */
export function markPipelineEditorSaved(): void {
  const session = appAtomRegistry.get(pipelineEditorSessionAtom);
  if (session) {
    appAtomRegistry.set(pipelineEditorSessionAtom, { ...session, initial: session.current });
  }
}

export function discardPipelineEditor(): void {
  appAtomRegistry.set(pipelineEditorSessionAtom, null);
}

export function usePipelineEditor() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const configs = useServerConfigs();
  const pipelineTargets = useMemo(
    () => selectedTargets.filter(pipelineTargetSupportsPipelines),
    [selectedTargets],
  );
  const defaultTarget = pipelineTargets[0];
  const modelForEnvironment = useCallback(
    (environmentId: EnvironmentId) =>
      pipelineStepDefaults(configs.get(environmentId) ?? null).modelSelection,
    [configs],
  );
  const defaultEditor = useMemo<PipelineEditor | null>(
    () =>
      defaultTarget
        ? {
            environmentId: defaultTarget.environmentId,
            environmentLabel: defaultTarget.label,
            draft: emptyPipelineDraft(
              pipelineStepDefaults(configs.get(defaultTarget.environmentId) ?? null),
              uuidv4,
            ),
            modelStepId: null,
          }
        : null,
    [defaultTarget, configs],
  );
  const session = useAtomValue(pipelineEditorSessionAtom);
  const editor = session ? session.current : defaultEditor;
  const initial = session ? session.initial : defaultEditor;
  const setEditor: Dispatch<SetStateAction<PipelineEditor | null>> = (update) => {
    const live = appAtomRegistry.get(pipelineEditorSessionAtom);
    const previous = live ? live.current : defaultEditor;
    appAtomRegistry.set(pipelineEditorSessionAtom, {
      initial: live ? live.initial : previous,
      current: typeof update === "function" ? update(previous) : update,
    });
  };
  return {
    editor,
    setEditor,
    pipelineTargets,
    hasChanges: pipelineEditorHasChanges(initial, editor),
    startEditor: startPipelineEditor,
    resetEditor: () => startPipelineEditor(defaultEditor),
    startFromStarter: (starter: PipelineStarter) => {
      if (!defaultTarget) return;
      const config = configs.get(defaultTarget.environmentId) ?? null;
      startPipelineEditor({
        environmentId: defaultTarget.environmentId,
        environmentLabel: defaultTarget.label,
        draft: starterToDraft(
          starter,
          uuidv4,
          pipelineStepDefaults(config),
          pipelineAvailableInstanceIds(config),
        ),
        modelStepId: null,
      });
    },
    modelForEnvironment,
  };
}

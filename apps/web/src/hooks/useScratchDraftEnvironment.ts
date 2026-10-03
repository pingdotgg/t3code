import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { type EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useState } from "react";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useClientSettings } from "./useSettings";
import { useScratchProject } from "./useScratchProject";

/**
 * Moves a draft without a project to another machine's Scratch project,
 * creating it there first if needed. The draft keeps its composer session,
 * so the prompt and model/mode selections carry over.
 */
export function useScratchDraftEnvironment({
  draftId,
  activeProject,
  canSwitch,
}: {
  draftId: DraftId | null;
  activeProject: EnvironmentProject | null;
  canSwitch: () => boolean;
}) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const { openScratchProject } = useScratchProject();
  const activeEnvironment = environments.find(
    (env) => env.environmentId === activeProject?.environmentId,
  );
  const isScratchDraft =
    draftId !== null &&
    activeProject !== null &&
    isScratchProject(activeProject, activeEnvironment?.serverConfig?.scratchWorkspaceRoot);
  const availableEnvironments = useMemo(
    () =>
      environments
        .filter(
          (env) => availableScratchWorkspaceRoot(env.connection.phase, env.serverConfig) !== null,
        )
        .map((env) => ({
          environmentId: env.environmentId,
          label: env.label,
          isPrimary: env.environmentId === primaryEnvironmentId,
          machine: resolveEnvironmentMachineKind(env.serverConfig),
        }))
        .sort((a, b) =>
          a.isPrimary !== b.isPrimary ? (a.isPrimary ? -1 : 1) : a.label.localeCompare(b.label),
        ),
    [environments, primaryEnvironmentId],
  );
  // The latest switch wins: a slower, earlier one must not retarget the draft.
  const latestRequestRef = useRef<{ readonly environmentId: EnvironmentId } | null>(null);
  const [pending, setPending] = useState(false);

  const selectEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      if (!isScratchDraft || !draftId || !activeProject || !canSwitch()) return;
      if (environmentId === activeProject.environmentId) {
        // Picking the current machine again cancels a switch still in flight.
        latestRequestRef.current = null;
        setPending(false);
        return;
      }
      const request = { environmentId };
      latestRequestRef.current = request;
      setPending(true);
      try {
        const project = await openScratchProject(environmentId, "Could not switch machine");
        if (latestRequestRef.current !== request || !project || !canSwitch()) return;
        const store = useComposerDraftStore.getState();
        const draft = store.getDraftSession(draftId);
        // Leave the draft alone if it was sent or moved while this switch ran.
        if (
          !draft ||
          draft.promotedTo ||
          draft.environmentId !== activeProject.environmentId ||
          draft.projectId !== activeProject.id
        ) {
          return;
        }
        store.setLogicalProjectDraftThreadId(
          deriveLogicalProjectKeyFromSettings(project, settings),
          scopeProjectRef(project.environmentId, project.id),
          draftId,
        );
        store.setDraftThreadContext(draftId, {
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
          envMode: "local",
        });
      } finally {
        if (latestRequestRef.current === request) {
          latestRequestRef.current = null;
          setPending(false);
        }
      }
    },
    [activeProject, canSwitch, draftId, isScratchDraft, openScratchProject, settings],
  );

  // Steps from the machine a switch is heading to, so repeated presses keep
  // advancing while the previous one is still being prepared.
  const cycleEnvironment = useCallback(() => {
    if (availableEnvironments.length < 2) return;
    const currentId = latestRequestRef.current?.environmentId ?? activeProject?.environmentId;
    const index = availableEnvironments.findIndex((env) => env.environmentId === currentId);
    const next = availableEnvironments[(index + 1) % availableEnvironments.length];
    if (next) void selectEnvironment(next.environmentId);
  }, [activeProject?.environmentId, availableEnvironments, selectEnvironment]);

  // Stable between renders so ChatView's callbacks and effects that depend on
  // it are not rebuilt on every streamed update.
  const visiblePending = isScratchDraft && pending;
  return useMemo(
    () => ({
      isScratchDraft,
      availableEnvironments,
      selectEnvironment,
      cycleEnvironment,
      pending: visiblePending,
    }),
    [isScratchDraft, availableEnvironments, selectEnvironment, cycleEnvironment, visiblePending],
  );
}

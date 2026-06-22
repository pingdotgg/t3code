import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { nextForkThreadTitle } from "../components/ChatView.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { readProject, readThreadShells } from "../state/entities";
import { useSettings } from "./useSettings";

/** The minimal thread shape needed to fork — satisfied by both `Thread` and `EnvironmentThreadShell`. */
export interface ForkableThread {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

/**
 * Returns a stable callback that forks a conversation: it creates a fresh, empty
 * draft inheriting the source thread's settings (model bundle + runtime +
 * interaction modes), titled `Fork: <name>` (deduped with the standard ` (N)`
 * suffix), tagged with `forkedFromThreadId`, and navigates to it. Like any new
 * chat the draft isn't persisted as a real thread until the first message.
 *
 * Project and thread-shell lookups are non-reactive (read at call time) so the
 * callback identity stays stable — safe to call per sidebar row.
 */
export function useForkThread(): (thread: ForkableThread) => Promise<void> {
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const router = useRouter();
  return useCallback(
    (thread: ForkableThread): Promise<void> => {
      const project = readProject(scopeProjectRef(thread.environmentId, thread.projectId));
      if (!project) {
        return Promise.resolve();
      }
      const projectRef = scopeProjectRef(project.environmentId, project.id);
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        project,
        projectGroupingSettings,
      );
      const {
        setLogicalProjectDraftThreadId,
        setModelSelection,
        setRuntimeMode,
        setInteractionMode,
      } = useComposerDraftStore.getState();
      const forkTitle = nextForkThreadTitle(
        thread.title,
        { environmentId: project.environmentId, projectId: project.id },
        readThreadShells(),
      );
      const forkDraftId = newDraftId();
      const forkThreadId = newThreadId();
      setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, forkDraftId, {
        threadId: forkThreadId,
        createdAt: new Date().toISOString(),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        envMode: thread.worktreePath ? "worktree" : "local",
        forkedFromThreadId: thread.id,
        titleSeed: forkTitle,
      });
      // A ModelSelection bundles model + reasoning effort + 1M + fast mode, so
      // copying it carries every model-side setting across in one go.
      setModelSelection(forkDraftId, thread.modelSelection);
      setRuntimeMode(forkDraftId, thread.runtimeMode);
      setInteractionMode(forkDraftId, thread.interactionMode);
      return router.navigate({ to: "/draft/$draftId", params: { draftId: forkDraftId } });
    },
    [projectGroupingSettings, router],
  );
}

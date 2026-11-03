import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { UnifiedSettings } from "@t3tools/contracts";
import { useStableCallback } from "../../hooks/useStableCallback";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { newDraftId, newThreadId } from "~/lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildDraftThreadRouteParams } from "../../threadRoutes";
import { type DraftThreadEnvMode, useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { openPullRequestThreadDialog } from "./ChatOverlayHosts";
interface PullRequestDraftThreadInput {
  readonly routeKind: "server" | "draft";
  readonly draftId: DraftId | null;
  readonly settings: UnifiedSettings;
  readonly projectGroupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
  readonly activeProject: EnvironmentProject | null;
  readonly activeThreadKey: string | null;
  readonly isServerThread: boolean;
  readonly canCheckoutPullRequestIntoThread: boolean;
}

/**
 * Checking out a pull request into a thread: opens the dialog, then puts the prepared branch or
 * worktree on the project's draft thread, reusing the one already open when there is one.
 */
export function usePullRequestDraftThread(input: PullRequestDraftThreadInput) {
  const {
    routeKind,
    draftId,
    settings,
    projectGroupingSettings,
    activeProject,
    activeThreadKey,
    isServerThread,
    canCheckoutPullRequestIntoThread,
  } = input;
  const navigate = useNavigate();
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );

  const openPullRequestDialog = (reference?: string) => {
    if (!canCheckoutPullRequestIntoThread) {
      return;
    }
    if (activeThreadKey === null) return;
    openPullRequestThreadDialog(activeThreadKey, reference);
  };
  const openPullRequestDialogStable = useStableCallback(openPullRequestDialog);

  const openOrReuseProjectDraftThread = async (input: {
    branch: string;
    worktreePath: string | null;
    envMode: DraftThreadEnvMode;
  }) => {
    if (!activeProject) {
      throw new Error("No active project is available for this pull request.");
    }
    const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
    const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
      activeProject,
      projectGroupingSettings,
    );
    const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
    if (storedDraftSession) {
      setDraftThreadContext(storedDraftSession.draftId, input);
      setLogicalProjectDraftThreadId(
        logicalProjectKey,
        activeProjectRef,
        storedDraftSession.draftId,
        {
          threadId: storedDraftSession.threadId,
          ...input,
        },
      );
      if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
        await navigate({
          to: "/draft/$draftId",
          params: buildDraftThreadRouteParams(storedDraftSession.draftId),
        });
      }
      return storedDraftSession.threadId;
    }

    const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
    if (!isServerThread && activeDraftSession?.logicalProjectKey === logicalProjectKey && draftId) {
      setDraftThreadContext(draftId, input);
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
        threadId: activeDraftSession.threadId,
        createdAt: activeDraftSession.createdAt,
        runtimeMode: activeDraftSession.runtimeMode,
        interactionMode: activeDraftSession.interactionMode,
        ...input,
      });
      return activeDraftSession.threadId;
    }

    const nextDraftId = newDraftId();
    const nextThreadId = newThreadId();
    setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
      threadId: nextThreadId,
      createdAt: new Date().toISOString(),
      runtimeMode: resolveProjectSettings(settings, activeProject.id, activeProject).settings
        .defaultRuntimeMode,
      interactionMode: DEFAULT_INTERACTION_MODE,
      ...input,
    });
    await navigate({
      to: "/draft/$draftId",
      params: buildDraftThreadRouteParams(nextDraftId),
    });
    return nextThreadId;
  };

  const handlePreparedPullRequestThread = async (input: {
    branch: string;
    worktreePath: string | null;
  }) => {
    await openOrReuseProjectDraftThread({
      branch: input.branch,
      worktreePath: input.worktreePath,
      envMode: input.worktreePath ? "worktree" : "local",
    });
  };
  const handlePreparedPullRequestThreadStable = useStableCallback(handlePreparedPullRequestThread);
  return {
    handlePreparedPullRequestThreadStable,
    openPullRequestDialogStable,
  };
}

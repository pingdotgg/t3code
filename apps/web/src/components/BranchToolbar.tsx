import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import {
  type EnvMode,
  type EnvironmentOption,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { Separator } from "./ui/separator";

interface BranchToolbarProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}

export const BranchToolbar = memo(function BranchToolbar({
  environmentId,
  threadId,
  draftId,
  onEnvModeChange,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
}: BranchToolbarProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const serverThreadSelector = useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]);
  const serverThread = useStore(serverThreadSelector);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProjectSelector = useMemo(
    () => createProjectSelectorByRef(activeProjectRef),
    [activeProjectRef],
  );
  const activeProject = useStore(activeProjectSelector);
  const hasActiveThread = serverThread !== undefined || draftThread !== null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: serverThread !== undefined,
    draftThreadEnvMode: draftThread?.envMode,
  });
  const envModeLocked = envLocked || (serverThread !== undefined && activeWorktreePath !== null);

  const showEnvironmentPicker =
    availableEnvironments && availableEnvironments.length > 1 && onEnvironmentChange;

  if (!hasActiveThread || !activeProject) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 pb-3 pt-1">
      <div className="flex items-center gap-1">
        {showEnvironmentPicker && (
          <>
            <BranchToolbarEnvironmentSelector
              envLocked={envLocked}
              environmentId={environmentId}
              availableEnvironments={availableEnvironments}
              onEnvironmentChange={onEnvironmentChange}
            />
            <Separator orientation="vertical" className="mx-0.5 h-3.5!" />
          </>
        )}
        <BranchToolbarEnvModeSelector
          envLocked={envModeLocked}
          effectiveEnvMode={effectiveEnvMode}
          activeWorktreePath={activeWorktreePath}
          onEnvModeChange={onEnvModeChange}
        />
      </div>

      <BranchToolbarBranchSelector
        environmentId={environmentId}
        threadId={threadId}
        {...(draftId ? { draftId } : {})}
        envLocked={envLocked}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
    </div>
  );
});

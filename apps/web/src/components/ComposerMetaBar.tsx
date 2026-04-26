import { scopeProjectRef, scopeThreadRef } from "@forma/client-runtime";
import type { EnvironmentId, RuntimeMode, ThreadId } from "@forma/contracts";
import { memo, useMemo } from "react";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { ContextWindowSnapshot } from "../lib/contextWindow";
import { useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { cn } from "~/lib/utils";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import {
  type EnvMode,
  type EnvironmentOption,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { ContextWindowMeter } from "./chat/ContextWindowMeter";
import { ComposerRuntimeModeControl } from "./chat/ComposerRuntimeModeControl";
import { Separator } from "./ui/separator";

interface ComposerMetaBarProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  showGitControls?: boolean;
  onEnvModeChange: (mode: EnvMode) => void;
  effectiveEnvModeOverride?: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  envLocked: boolean;
  runtimeMode: RuntimeMode;
  runtimeModeLocked: boolean;
  runtimeModeLockReason?: string | undefined;
  activeContextWindow: ContextWindowSnapshot | null;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}

export const ComposerMetaBar = memo(function ComposerMetaBar({
  environmentId,
  threadId,
  draftId,
  showGitControls = true,
  onEnvModeChange,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  envLocked,
  runtimeMode,
  runtimeModeLocked,
  runtimeModeLockReason,
  activeContextWindow,
  onRuntimeModeChange,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
}: ComposerMetaBarProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const serverThreadSelector = useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]);
  const serverThread = useStore(serverThreadSelector);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
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
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread: serverThread !== undefined,
      draftThreadEnvMode: draftThread?.envMode,
    });
  const envModeLocked = envLocked || (serverThread !== undefined && activeWorktreePath !== null);
  const showEnvironmentPicker = Boolean(
    availableEnvironments && availableEnvironments.length > 1 && onEnvironmentChange,
  );
  const showLeftCluster = Boolean(showGitControls && hasActiveThread && activeProject);

  return (
    <div className="mx-auto mt-1 flex w-full max-w-208 flex-wrap items-center gap-x-3 gap-y-2">
      {showLeftCluster ? (
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {showEnvironmentPicker ? (
            <>
              <BranchToolbarEnvironmentSelector
                envLocked={envLocked}
                environmentId={environmentId}
                availableEnvironments={availableEnvironments!}
                onEnvironmentChange={onEnvironmentChange!}
              />
              <Separator orientation="vertical" className="mx-0.5 h-3.5!" />
            </>
          ) : null}

          <BranchToolbarEnvModeSelector
            envLocked={envModeLocked}
            effectiveEnvMode={effectiveEnvMode}
            activeWorktreePath={activeWorktreePath}
            onEnvModeChange={onEnvModeChange}
          />

          <Separator orientation="vertical" className="mx-0.5 h-3.5!" />

          <div className="min-w-0">
            <BranchToolbarBranchSelector
              environmentId={environmentId}
              threadId={threadId}
              {...(draftId ? { draftId } : {})}
              envLocked={envLocked}
              {...(effectiveEnvModeOverride ? { effectiveEnvModeOverride } : {})}
              {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
              {...(onActiveThreadBranchOverrideChange
                ? { onActiveThreadBranchOverrideChange }
                : {})}
              {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
              {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
            />
          </div>
        </div>
      ) : null}

      <div
        className={cn(
          "flex min-w-0 shrink-0 items-center gap-1.5",
          showLeftCluster ? "ml-auto" : "w-full justify-end",
        )}
      >
        <ComposerRuntimeModeControl
          runtimeMode={runtimeMode}
          runtimeModeLocked={runtimeModeLocked}
          runtimeModeLockReason={runtimeModeLockReason}
          onRuntimeModeChange={onRuntimeModeChange}
        />

        {activeContextWindow ? (
          <>
            <Separator orientation="vertical" className="mx-0.5 h-3.5!" />
            <ContextWindowMeter usage={activeContextWindow} variant="labeled" />
          </>
        ) : null}
      </div>
    </div>
  );
});

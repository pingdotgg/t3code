import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationLatestTurn,
  EnvironmentId,
  ProviderInstanceId,
  ServerConfig,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { newThreadId } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { useServerConfigs, waitForThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  canForkCompletedAssistantMessage,
  completedTurnIdsFromCheckpoints,
  resolveForkEntryAvailability,
  type ThreadForkTarget,
} from "../threadForking.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

interface ForkableThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
  readonly modelSelection: { readonly instanceId: ProviderInstanceId };
  readonly session: { readonly providerInstanceId?: ProviderInstanceId | undefined } | null;
}

type ForkSourceThread = Pick<ForkableThread, "environmentId" | "id">;

function providerConfigForThread(
  thread: ForkableThread,
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
) {
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  return serverConfigs
    .get(thread.environmentId)
    ?.providers.find((provider) => provider.instanceId === instanceId);
}

export function useThreadForkActions(
  sourceThread: ForkableThread | null | undefined,
  options?: { readonly panelHostThreadId?: ThreadId | null },
) {
  const navigate = useNavigate();
  const serverConfigs = useServerConfigs();
  const forkCommand = useAtomCommand(threadEnvironment.fork, { reportFailure: false });
  const capability = sourceThread
    ? providerConfigForThread(sourceThread, serverConfigs)?.sessionFork
    : undefined;
  const latest = useMemo(
    () =>
      resolveForkEntryAvailability({
        capability,
        latestTurn: sourceThread?.latestTurn,
        ...(sourceThread
          ? {
              messages: sourceThread.messages,
              completedTurnIds: completedTurnIdsFromCheckpoints(sourceThread.checkpoints),
            }
          : {}),
      }),
    [capability, sourceThread],
  );

  // Callbacks handed to memoized rows must stay identity-stable, so they read
  // the latest inputs from one ref that is refreshed in an effect rather than
  // during render.
  const latestInputsRef = useRef({
    sourceThread,
    capability,
    latestTarget: latest.target,
    latestEnabled: latest.enabled,
    panelHostThreadId: options?.panelHostThreadId ?? null,
    forkCommand,
    navigate,
  });
  useEffect(() => {
    latestInputsRef.current = {
      sourceThread,
      capability,
      latestTarget: latest.target,
      latestEnabled: latest.enabled,
      panelHostThreadId: options?.panelHostThreadId ?? null,
      forkCommand,
      navigate,
    };
  });
  const forkInFlightRef = useRef(false);

  const dispatchFork = useCallback(
    async (
      target: ThreadForkTarget,
      sideChat: boolean,
      sourceOverride?: ForkSourceThread,
    ): Promise<boolean> => {
      const currentSourceThread = sourceOverride ?? latestInputsRef.current.sourceThread;
      if (!currentSourceThread) return false;
      if (forkInFlightRef.current) return false;
      // Resolve the panel host before awaiting: the user can navigate while
      // the fork syncs, and the side chat must open beside the thread it was
      // started from, not wherever the route ended up.
      const hostThreadId =
        sourceOverride?.id ?? latestInputsRef.current.panelHostThreadId ?? currentSourceThread.id;
      const hostIsActiveRoute = sourceOverride === undefined;
      forkInFlightRef.current = true;
      try {
        const threadId = newThreadId();
        const result = await latestInputsRef.current.forkCommand({
          environmentId: currentSourceThread.environmentId,
          input: {
            threadId,
            sourceThreadId: currentSourceThread.id,
            sourceTurnId: target.turnId,
            sourceMessageId: target.messageId,
            sideChat,
            createdAt: new Date().toISOString(),
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: sideChat ? "Could not open side chat" : "Could not fork thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return false;
        }

        const forkedThreadRef = scopeThreadRef(currentSourceThread.environmentId, threadId);
        try {
          await waitForThreadShell(forkedThreadRef);
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: sideChat ? "Side chat created but not opened" : "Fork created but not opened",
              description: error instanceof Error ? error.message : "The thread is still syncing.",
            }),
          );
          return false;
        }

        if (sideChat) {
          const hostRef = scopeThreadRef(currentSourceThread.environmentId, hostThreadId);
          // A side chat started from another thread's row (sidebar menu) is
          // only visible in that thread's panel, so go there first.
          if (!hostIsActiveRoute) {
            await latestInputsRef.current.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: hostRef.environmentId, threadId: hostRef.threadId },
            });
          }
          useRightPanelStore.getState().openSideChat(hostRef, threadId);
          return true;
        }

        await latestInputsRef.current.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: currentSourceThread.environmentId, threadId },
        });
        return true;
      } finally {
        forkInFlightRef.current = false;
      }
    },
    [],
  );

  const forkLatest = useCallback(
    (sideChat: boolean) => {
      const target = latestInputsRef.current.latestTarget;
      return latestInputsRef.current.latestEnabled && target
        ? dispatchFork(target, sideChat)
        : Promise.resolve(false);
    },
    [dispatchFork],
  );

  const forkTarget = useCallback(
    (source: ForkSourceThread, target: ThreadForkTarget, sideChat: boolean) =>
      dispatchFork(target, sideChat, source),
    [dispatchFork],
  );

  const onForkAssistantMessage = useCallback(
    (input: {
      readonly messageId: MessageId;
      readonly turnId: TurnId;
      readonly sideChat: boolean;
    }) => {
      if (
        !canForkCompletedAssistantMessage({
          capability: latestInputsRef.current.capability,
          completed: true,
          messageTurnId: input.turnId,
          latestCompletedTurnId: latestInputsRef.current.latestTarget?.turnId ?? null,
        })
      ) {
        return Promise.resolve(false);
      }
      return dispatchFork({ turnId: input.turnId, messageId: input.messageId }, input.sideChat);
    },
    [dispatchFork],
  );

  return useMemo(
    () => ({ capability, latest, forkLatest, forkTarget, onForkAssistantMessage }),
    [capability, forkLatest, forkTarget, latest, onForkAssistantMessage],
  );
}

import { useCallback } from "react";

import {
  CommandId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";

import { uuidv4 } from "../lib/uuid";
import { environmentRuntimeManager } from "./use-environment-runtime";
import { getEnvironmentClient } from "./environment-session-registry";
import { useRemoteEnvironmentState } from "./use-remote-environment-registry";
import { useThreadSelection } from "./use-thread-selection";

export function useSelectedThreadCommands(input: {
  readonly refreshSelectedThreadGitStatus: (options?: {
    readonly quiet?: boolean;
    readonly cwd?: string | null;
  }) => Promise<unknown>;
}) {
  const { refreshSelectedThreadGitStatus } = input;
  const { selectedThread } = useThreadSelection();
  const { savedConnectionsById } = useRemoteEnvironmentState();

  const onRefresh = useCallback(async () => {
    const targets = selectedThread
      ? [selectedThread.environmentId]
      : Object.values(savedConnectionsById).map((connection) => connection.environmentId);

    await Promise.all(
      targets.map(async (environmentId) => {
        const client = getEnvironmentClient(environmentId);
        if (!client) {
          return;
        }

        try {
          const serverConfig = await client.server.getConfig();
          environmentRuntimeManager.patch({ environmentId }, (current) => ({
            ...current,
            serverConfig,
            connectionError: null,
          }));
        } catch (error) {
          environmentRuntimeManager.patch({ environmentId }, (current) => ({
            ...current,
            connectionError:
              error instanceof Error ? error.message : "Failed to refresh remote data.",
          }));
        }
      }),
    );

    if (selectedThread) {
      await refreshSelectedThreadGitStatus({ quiet: true });
    }
  }, [refreshSelectedThreadGitStatus, savedConnectionsById, selectedThread]);

  const onUpdateThreadModelSelection = useCallback(
    async (modelSelection: ModelSelection) => {
      if (!selectedThread) {
        return;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return;
      }

      await client.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: CommandId.make(uuidv4()),
        threadId: selectedThread.id,
        modelSelection,
      });
    },
    [selectedThread],
  );

  const onUpdateThreadRuntimeMode = useCallback(
    async (runtimeMode: RuntimeMode) => {
      if (!selectedThread) {
        return;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return;
      }

      await client.orchestration.dispatchCommand({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make(uuidv4()),
        threadId: selectedThread.id,
        runtimeMode,
        createdAt: new Date().toISOString(),
      });
    },
    [selectedThread],
  );

  const onUpdateThreadInteractionMode = useCallback(
    async (interactionMode: ProviderInteractionMode) => {
      if (!selectedThread) {
        return;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return;
      }

      await client.orchestration.dispatchCommand({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make(uuidv4()),
        threadId: selectedThread.id,
        interactionMode,
        createdAt: new Date().toISOString(),
      });
    },
    [selectedThread],
  );

  const onStopThread = useCallback(async () => {
    if (!selectedThread) {
      return;
    }

    const client = getEnvironmentClient(selectedThread.environmentId);
    if (!client) {
      return;
    }

    if (
      selectedThread.session?.status !== "running" &&
      selectedThread.session?.status !== "starting"
    ) {
      return;
    }

    await client.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: CommandId.make(uuidv4()),
      threadId: selectedThread.id,
      ...(selectedThread.session?.activeTurnId
        ? { turnId: selectedThread.session.activeTurnId }
        : {}),
      createdAt: new Date().toISOString(),
    });
  }, [selectedThread]);

  const onRenameThread = useCallback(
    async (title: string) => {
      if (!selectedThread) {
        return;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return;
      }

      const trimmed = title.trim();
      if (!trimmed || trimmed === selectedThread.title) {
        return;
      }

      await client.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: CommandId.make(uuidv4()),
        threadId: selectedThread.id,
        title: trimmed,
      });
    },
    [selectedThread],
  );

  return {
    onRefresh,
    onUpdateThreadModelSelection,
    onUpdateThreadRuntimeMode,
    onUpdateThreadInteractionMode,
    onRenameThread,
    onStopThread,
  };
}

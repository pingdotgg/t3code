import { useCallback, useState } from "react";
import { Alert } from "react-native";

import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime";
import {
  ApprovalRequestId,
  CommandId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type RuntimeMode,
  type UserInputQuestion,
} from "@t3tools/contracts";

import { uuidv4 } from "../../lib/uuid";
import { environmentRuntimeManager } from "../../state/use-environment-runtime";
import {
  getEnvironmentClient,
  useRemoteEnvironmentState,
} from "../../state/use-remote-environment-registry";
import { useThreadSelection } from "../../state/use-thread-selection";

export function useSelectedThreadCommands(input: {
  readonly activePendingUserInput: {
    readonly requestId: ApprovalRequestId;
    readonly questions: ReadonlyArray<UserInputQuestion>;
  } | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly refreshSelectedThreadGitStatus: (options?: {
    readonly quiet?: boolean;
    readonly cwd?: string | null;
  }) => Promise<unknown>;
}) {
  const { activePendingUserInput, activePendingUserInputDrafts, refreshSelectedThreadGitStatus } =
    input;
  const { selectedThread } = useThreadSelection();
  const { savedConnectionsById } = useRemoteEnvironmentState();
  const [respondingApprovalId, setRespondingApprovalId] = useState<ApprovalRequestId | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );

  const onRefresh = useCallback(async () => {
    const targets = selectedThread
      ? [selectedThread.environmentId]
      : Object.keys(savedConnectionsById);

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

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!selectedThread) {
        return;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return;
      }

      setRespondingApprovalId(requestId);
      try {
        await client.orchestration.dispatchCommand({
          type: "thread.approval.respond",
          commandId: CommandId.make(uuidv4()),
          threadId: selectedThread.id,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        });
      } finally {
        setRespondingApprovalId((current) => (current === requestId ? null : current));
      }
    },
    [selectedThread],
  );

  const onSubmitUserInput = useCallback(async () => {
    if (!selectedThread || !activePendingUserInput) {
      return;
    }

    const answers = buildPendingUserInputAnswers(
      activePendingUserInput.questions,
      activePendingUserInputDrafts,
    );
    if (!answers) {
      return;
    }

    const client = getEnvironmentClient(selectedThread.environmentId);
    if (!client) {
      return;
    }

    setRespondingUserInputId(activePendingUserInput.requestId);
    try {
      await client.orchestration.dispatchCommand({
        type: "thread.user-input.respond",
        commandId: CommandId.make(uuidv4()),
        threadId: selectedThread.id,
        requestId: activePendingUserInput.requestId,
        answers,
        createdAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      // Surface network / RPC errors so the user can retry (matches web parity
      // where the error is displayed via setThreadError).
      Alert.alert(
        "Failed to submit",
        err instanceof Error ? err.message : "Something went wrong. Please try again.",
      );
    } finally {
      setRespondingUserInputId((current) =>
        current === activePendingUserInput.requestId ? null : current,
      );
    }
  }, [activePendingUserInput, activePendingUserInputDrafts, selectedThread]);

  return {
    respondingApprovalId,
    respondingUserInputId,
    onRefresh,
    onUpdateThreadModelSelection,
    onUpdateThreadRuntimeMode,
    onUpdateThreadInteractionMode,
    onRenameThread,
    onStopThread,
    onRespondToApproval,
    onSubmitUserInput,
  };
}

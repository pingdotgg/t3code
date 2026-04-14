import { useCallback } from "react";

import { EnvironmentScopedProjectShell } from "@t3tools/client-runtime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  type GitBranch,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { uuidv4 } from "../../lib/uuid";
import { environmentRuntimeManager } from "../../state/use-environment-runtime";
import { gitBranchManager } from "../../state/use-git-branches";
import { useRemoteCatalog } from "../../state/use-remote-catalog";
import {
  getEnvironmentClient,
  setPendingConnectionError,
  useRemoteEnvironmentState,
} from "../../state/use-remote-environment-registry";

function useRefreshRemoteData() {
  const { savedConnectionsById } = useRemoteEnvironmentState();

  return useCallback(
    async (environmentIds?: ReadonlyArray<string>) => {
      const targets = environmentIds ?? Object.keys(savedConnectionsById);

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
    },
    [savedConnectionsById],
  );
}

function deriveThreadTitleFromPrompt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "New thread";
  }

  const compact = trimmed.replace(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

export function useProjectActions() {
  const { threads } = useRemoteCatalog();
  const refreshRemoteData = useRefreshRemoteData();

  const onCreateThreadWithOptions = useCallback(
    async (input: {
      readonly project: EnvironmentScopedProjectShell;
      readonly modelSelection: ModelSelection;
      readonly envMode: "local" | "worktree";
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly initialMessageText: string;
      readonly initialAttachments: ReadonlyArray<DraftComposerImageAttachment>;
    }) => {
      const client = getEnvironmentClient(input.project.environmentId);
      if (!client) {
        return null;
      }

      const threadId = ThreadId.make(uuidv4());
      const createdAt = new Date().toISOString();
      const initialMessageText = input.initialMessageText.trim();
      const nextTitle = deriveThreadTitleFromPrompt(input.initialMessageText);

      if (initialMessageText.length === 0) {
        return null;
      }
      if (input.envMode === "worktree" && !input.branch) {
        return null;
      }

      const isWorktree = input.envMode === "worktree";

      await client.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: CommandId.make(uuidv4()),
        threadId,
        message: {
          messageId: MessageId.make(uuidv4()),
          role: "user",
          text: initialMessageText,
          attachments: input.initialAttachments,
        },
        modelSelection: input.modelSelection,
        titleSeed: nextTitle,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        bootstrap: {
          createThread: {
            projectId: input.project.id,
            title: nextTitle,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: input.branch,
            worktreePath: isWorktree ? null : input.worktreePath,
            createdAt,
          },
          ...(isWorktree
            ? {
                prepareWorktree: {
                  projectCwd: input.project.workspaceRoot,
                  baseBranch: input.branch!,
                  branch: buildTemporaryWorktreeBranchName(),
                },
                runSetupScript: true,
              }
            : {}),
        },
        createdAt: new Date().toISOString(),
      });

      await refreshRemoteData([input.project.environmentId]);
      return {
        environmentId: input.project.environmentId,
        threadId,
      };
    },
    [refreshRemoteData],
  );

  const onCreateThread = useCallback(
    async (project: EnvironmentScopedProjectShell) => {
      const latestProjectThread =
        threads.find(
          (thread) =>
            thread.environmentId === project.environmentId && thread.projectId === project.id,
        ) ?? null;
      const modelSelection =
        project.defaultModelSelection ?? latestProjectThread?.modelSelection ?? null;
      if (!modelSelection) {
        setPendingConnectionError("This project does not have a default model configured yet.");
        return null;
      }

      return await onCreateThreadWithOptions({
        project,
        modelSelection,
        envMode: "local",
        branch: null,
        worktreePath: null,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        initialMessageText: "",
        initialAttachments: [],
      });
    },
    [onCreateThreadWithOptions, threads],
  );

  const onListProjectBranches = useCallback(
    async (project: EnvironmentScopedProjectShell): Promise<ReadonlyArray<GitBranch>> => {
      const client = getEnvironmentClient(project.environmentId);
      if (!client) {
        return [];
      }

      try {
        const result = await gitBranchManager.load(
          { environmentId: project.environmentId, cwd: project.workspaceRoot, query: null },
          client.git,
          { limit: 100 },
        );
        return (result?.branches ?? []).filter((branch) => !branch.isRemote);
      } catch (error) {
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to load branches.",
        );
        return [];
      }
    },
    [],
  );

  const onCreateProjectWorktree = useCallback(
    async (
      project: EnvironmentScopedProjectShell,
      nextWorktree: {
        readonly baseBranch: string;
        readonly newBranch: string;
      },
    ): Promise<{
      readonly branch: string;
      readonly worktreePath: string;
    } | null> => {
      const client = getEnvironmentClient(project.environmentId);
      if (!client) {
        return null;
      }

      try {
        const result = await client.git.createWorktree({
          cwd: project.workspaceRoot,
          branch: nextWorktree.baseBranch,
          newBranch: sanitizeFeatureBranchName(nextWorktree.newBranch),
          path: null,
        });
        gitBranchManager.invalidate({
          environmentId: project.environmentId,
          cwd: project.workspaceRoot,
          query: null,
        });
        return {
          branch: result.worktree.branch,
          worktreePath: result.worktree.path,
        };
      } catch (error) {
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to create worktree.",
        );
        return null;
      }
    },
    [],
  );

  return {
    onCreateThread,
    onCreateThreadWithOptions,
    onListProjectBranches,
    onCreateProjectWorktree,
    onRefreshProjects: refreshRemoteData,
  };
}

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useState } from "react";
import { Alert } from "react-native";

import { buildModelOptions, resolveDefaultableModelSelection } from "../../lib/modelOptions";
import { gitEnvironment } from "../../state/git";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useCreateProjectThread } from "../threads/use-project-actions";

function readableError(failure: unknown, fallback: string): string {
  if (failure instanceof Error && failure.message.trim().length > 0) {
    return failure.message;
  }
  if (typeof failure === "string" && failure.trim().length > 0) {
    return failure;
  }
  return fallback;
}

/**
 * Checks the pull request out into a worktree, then starts a thread on that checkout
 * with the given prompt as the first message. Mobile cannot open an empty composer the
 * way desktop does, so the prompt is sent immediately after the user confirms.
 */
export function usePullRequestHandoff() {
  const navigation = useNavigation();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const createProjectThread = useCreateProjectThread();
  const preparePullRequestThread = useAtomCommand(gitEnvironment.preparePullRequestThread, {
    reportFailure: false,
  });
  const [pendingKind, setPendingKind] = useState<string | null>(null);

  const startHandoff = useCallback(
    async (input: {
      readonly kind: string;
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly url: string;
      readonly prompt: string;
    }) => {
      if (pendingKind !== null) return false;
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === input.environmentId && candidate.id === input.projectId,
      );
      if (project === undefined) {
        Alert.alert(
          "Could not start a thread",
          "The project for this pull request is not available on this environment.",
        );
        return false;
      }
      const config = serverConfigs.get(input.environmentId) ?? null;
      const modelOptions = buildModelOptions(config, project.defaultModelSelection);
      const modelSelection =
        resolveDefaultableModelSelection(config, project.defaultModelSelection) ??
        modelOptions.find((option) => option.isDefault)?.selection ??
        modelOptions[0]?.selection ??
        null;
      if (modelSelection === null) {
        Alert.alert(
          "Could not start a thread",
          "No model is available on this environment. Check Settings → Environments.",
        );
        return false;
      }

      setPendingKind(input.kind);
      try {
        const prepared = await preparePullRequestThread({
          environmentId: input.environmentId,
          input: {
            cwd: project.workspaceRoot,
            reference: input.url,
            mode: "worktree",
          },
        });
        if (AsyncResult.isFailure(prepared)) {
          Alert.alert(
            "Could not prepare the pull request checkout",
            readableError(
              squashAtomCommandFailure(prepared),
              "The branch could not be checked out. Try again from the project.",
            ),
          );
          return false;
        }
        if (prepared.value.worktreePath === null) {
          Alert.alert(
            "Could not prepare the pull request checkout",
            "The environment did not return a worktree for this pull request.",
          );
          return false;
        }

        const created = await createProjectThread({
          project,
          modelSelection,
          envMode: "local",
          branch: prepared.value.branch,
          worktreePath: prepared.value.worktreePath,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          initialMessageText: input.prompt,
          initialAttachments: [],
        });
        if (created._tag === "Failure") {
          Alert.alert(
            "Checked out, but the thread could not start",
            `The checkout is ready on \`${prepared.value.branch}\`. Start a task from the project and point it at that branch.`,
          );
          return false;
        }
        if (!prepared.value.isOnPullRequestHead) {
          Alert.alert(
            "Checked out, but not on the latest commits",
            "The checkout could not be moved onto the pull request's latest commits, so the code there is older than the pull request. Uncommitted work or local commits keep it where it is.",
          );
        }
        navigation.navigate("Thread", {
          environmentId: created.value.environmentId,
          threadId: created.value.threadId,
        });
        return true;
      } finally {
        setPendingKind(null);
      }
    },
    [
      createProjectThread,
      navigation,
      pendingKind,
      preparePullRequestThread,
      projects,
      serverConfigs,
    ],
  );

  return { pendingKind, startHandoff };
}

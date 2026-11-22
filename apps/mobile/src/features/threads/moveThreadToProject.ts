import { threadMoveTargets, type EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { threadMoveNotice } from "@t3tools/shared/threadMove";
import * as Haptics from "expo-haptics";
import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";

/** Projects this thread can move into, on a server that can move it. */
export function readThreadMoveTargets(
  thread: EnvironmentThreadShell,
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyArray<EnvironmentProject> {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(thread.environmentId);
  if (config?.environment.capabilities.threadMoveToProject !== true) return [];
  return threadMoveTargets(projects, thread, config.scratchWorkspaceRoot);
}

export function moveThreadToProject(
  thread: EnvironmentThreadShell,
  project: EnvironmentProject,
): void {
  const failureTitle = m(msg("Could not move thread"));
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
    Dialog.alert(failureTitle, m(msg("This connection cannot change threads.")));
    return;
  }
  Dialog.confirm({
    title: m(
      msg('Move "{thread}" to {project}?', { thread: thread.title, project: project.title }),
    ),
    message: threadMoveNotice({
      projectTitle: project.title,
      fromWorktree: thread.worktreePath !== null,
    }),
    confirmText: m(msg("Move", { $context: "verb, moves a thread" })),
    onConfirm: () => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      void runAtomCommand(
        appAtomRegistry,
        projectEnvironment.moveThread,
        {
          environmentId: thread.environmentId,
          input: { threadId: thread.id, projectId: project.id },
        },
        { reportFailure: false },
      ).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Dialog.alert(failureTitle, error instanceof Error ? error.message : m(msg("Try again.")));
        }
      });
    },
  });
}

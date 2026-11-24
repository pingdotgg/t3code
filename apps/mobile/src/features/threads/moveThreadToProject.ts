import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, ProjectId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../state/atom-registry";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";

export const MOVE_PROJECT_PREFIX = "move-project:";

/** Other projects in the thread's environment; the server rejects running threads and subagents. */
export function moveProjectTargets(
  thread: EnvironmentThreadShell,
  projects: ReadonlyArray<EnvironmentProject>,
) {
  if (thread.lineage.relationshipToParent === "subagent") return [];
  return projects
    .filter(
      (project) =>
        project.environmentId === thread.environmentId &&
        project.id !== thread.projectId &&
        project.archivedAt == null,
    )
    .map((project) => ({
      id: project.id,
      title: project.isScratch ? m(msg("No project")) : project.title,
    }));
}

export async function moveThreadToProject(
  thread: EnvironmentThreadShell,
  projectId: string,
): Promise<void> {
  const title = m(msg("Could not move thread"));
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
    Dialog.alert(title, m(msg("This connection cannot change threads.")));
    return;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.updateMetadata,
    {
      environmentId: thread.environmentId,
      input: { threadId: thread.id, projectId: ProjectId.make(projectId) },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(title, errorDisplayMessage(error, m) ?? m(msg("Try again.")));
  }
}

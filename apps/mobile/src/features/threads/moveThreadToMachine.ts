import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  moveThreadToMachine as runThreadMachineMove,
  threadMachineMoveTargets,
  type ThreadMachineMoveTarget,
} from "@t3tools/client-runtime/state/threadMachineMove";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { threadMachineMoveNotice } from "@t3tools/shared/threadMove";
import * as Haptics from "expo-haptics";
import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../state/atom-registry";
import { connectedEnvironmentIdsAtom, environmentPresentations } from "../../state/presentation";
import { projectEnvironment } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";

const machineLabel = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId)?.entry.target
    .label;

/** Other connected machines this thread can move to, each with its projects. */
export function readThreadMachineMoveTargets(
  thread: EnvironmentThreadShell,
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyArray<ThreadMachineMoveTarget> {
  return threadMachineMoveTargets({
    sourceEnvironmentId: thread.environmentId,
    connectedEnvironmentIds: appAtomRegistry.get(connectedEnvironmentIdsAtom),
    serverConfigs: appAtomRegistry.get(environmentServerConfigsAtom),
    projects,
    labelOf: machineLabel,
    canOperate: (environmentId) =>
      readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
  });
}

export async function moveThreadToMachine(
  thread: EnvironmentThreadShell,
  machine: ThreadMachineMoveTarget,
  project: EnvironmentProject,
): Promise<void> {
  const fromMachine = machineLabel(thread.environmentId) ?? "this machine";
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
    Dialog.alert(m(msg("Could not move thread")), m(msg("This connection cannot change threads.")));
    return;
  }
  const outcome = await runThreadMachineMove({
    registry: appAtomRegistry,
    commands: projectEnvironment,
    source: { environmentId: thread.environmentId, threadId: thread.id },
    sourceLabel: fromMachine,
    target: { environmentId: machine.environmentId, projectId: project.id },
    targetLabel: `${project.title} on ${machine.label}`,
    confirm: ({ leftBehind }) =>
      new Promise((resolve) =>
        Dialog.confirm({
          title: m(
            msg('Move "{thread}" to {machine}?', { thread: thread.title, machine: machine.label }),
          ),
          message: threadMachineMoveNotice({
            fromMachine,
            toMachine: machine.label,
            projectTitle: project.title,
            leftBehind,
          }),
          confirmText: m(msg("Move", { $context: "verb, moves a thread" })),
          onCancel: () => resolve(false),
          onConfirm: () => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            resolve(true);
          },
        }),
      ),
    resolve: m,
  });
  if (outcome._tag === "Failed") Dialog.alert(m(msg("Could not move thread")), outcome.message);
  if (outcome._tag === "Moved" && outcome.archiveError !== null) {
    Dialog.alert(
      m(msg("Moved, but the original is still active on {machine}", { machine: fromMachine })),
      m(
        msg("{error} The moved copy is on {machine}.", {
          error: outcome.archiveError,
          machine: machine.label,
        }),
      ),
    );
  }
}

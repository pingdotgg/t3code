import {
  createSandboxActions,
  runSandboxHostCommand,
} from "@t3tools/client-runtime/sandboxes/actions";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { sandboxEnvironment } from "../../state/sandboxes";
import { environmentThreadShells } from "../../state/threads";

/** Runs one of the host's Sandbox commands, resolving with its value or why it failed. */
export function runOnHost<Input, A, E>(
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: Input }, A, E>,
  hostEnvironmentId: EnvironmentId,
  input: Input,
) {
  return runSandboxHostCommand(appAtomRegistry, command, hostEnvironmentId, input);
}

const actions = createSandboxActions({
  registry: appAtomRegistry,
  commands: {
    start: sandboxEnvironment.start,
    stop: sandboxEnvironment.stop,
    remove: sandboxEnvironment.remove,
  },
  severalHostsAtom: sandboxEnvironment.severalHostsAtom,
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
  presentationsAtom: environmentPresentations.presentationsAtom,
  confirm: (confirmation) =>
    new Promise((resolve) =>
      Dialog.confirm({
        title: confirmation.title,
        message: confirmation.message,
        confirmText: confirmation.confirmLabel,
        destructive: confirmation.destructive,
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      }),
    ),
  reportError: (title, description) => Dialog.alert(title, description),
});

export const startSandbox = actions.start;
export const stopSandbox = actions.stop;
export const deleteSandbox = actions.remove;

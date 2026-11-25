import {
  createSandboxActions,
  runSandboxHostCommand,
} from "@t3tools/client-runtime/sandboxes/actions";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { requestConfirmDialog } from "../confirmDialog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { sandboxEnvironment } from "../state/sandboxes";
import { environmentThreadShells } from "../state/threads";

/** Runs one of the host's Sandbox commands, as the page, palette and banners all do. */
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
  confirm: async ({ title, message, destructive }) =>
    (await requestConfirmDialog(
      `${title}\n${message}`,
      destructive ? { variant: "destructive" } : undefined,
    )) ?? false,
  reportError: (title, description) =>
    toastManager.add(stackedThreadToast({ type: "error", title, description })),
});

export const startSandbox = actions.start;
export const stopSandbox = actions.stop;
export const deleteSandbox = actions.remove;

import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { pluginActionLabels, pluginActionsAt } from "@t3tools/client-runtime/state/pluginActions";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type PluginAction,
  type PluginActionTarget,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { toastManager } from "./components/ui/toast";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { pluginActionEnvironment, readPluginActions } from "./state/pluginActions";
import { readEnvironmentScope } from "./state/session";

/** The plugin entries of a thread's action menu, read when the menu opens. */
export function threadMenuPluginActions(threadRef: ScopedThreadRef, projectId: ProjectId) {
  const entries = pluginActionsAt(readPluginActions(threadRef.environmentId), "thread-menu", {
    threadId: threadRef.threadId,
    projectId,
  });
  const labels = pluginActionLabels(entries.map((entry) => entry.action));
  return entries.map((entry, index) => ({
    ...entry,
    environmentId: threadRef.environmentId,
    id: `plugin-action:${entry.action.id}` as const,
    label: labels[index] ?? entry.action.title,
  }));
}

/** Whether this connection may run plugin actions now, read from the live grant. */
export function canRunPluginActionsNow(environmentId: EnvironmentId): boolean {
  return readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
}

/**
 * Runs a plugin action in the environment that listed it and reports the
 * outcome in a toast. The environment and target are fixed when the user
 * picks the action, so a later navigation cannot redirect it. The grant is
 * read when the action runs, not when it was offered, so a palette entry
 * picked after the grant changed is refused. Resolves `true` only when the
 * plugin ran the action.
 */
export async function runPluginAction(input: {
  readonly environmentId: EnvironmentId;
  readonly action: PluginAction;
  readonly target: PluginActionTarget;
}): Promise<boolean> {
  const { action } = input;
  if (!canRunPluginActionsNow(input.environmentId)) {
    toastManager.add({
      type: "error",
      title: `${action.title} unavailable`,
      description: "This connection cannot run plugin actions.",
    });
    return false;
  }
  const result = await runAtomCommand(
    appAtomRegistry,
    pluginActionEnvironment.invoke,
    { environmentId: input.environmentId, input: { actionId: action.id, target: input.target } },
    { reportFailure: false },
  );
  if (result._tag === "Success") {
    toastManager.add({
      type: "success",
      title: action.title,
      ...(result.value.message === null ? {} : { description: result.value.message }),
    });
    return true;
  }
  if (isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title: `${action.title} failed`,
    description: error instanceof Error ? error.message : "The plugin action failed.",
  });
  return false;
}

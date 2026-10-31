import { createPluginActionEnvironmentAtoms } from "@t3tools/client-runtime/state/pluginActions";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type PluginAction,
  type PluginActionTarget,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { Alert } from "react-native";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";
import { readEnvironmentScope } from "./session";

const pluginActionEnvironment = createPluginActionEnvironmentAtoms(connectionAtomRuntime);

const NO_ACTIONS: ReadonlyArray<PluginAction> = [];

/** The environment's plugin actions; none on servers without them. */
export function usePluginActions(environmentId: EnvironmentId | null): ReadonlyArray<PluginAction> {
  return (
    useEnvironmentQuery(
      environmentId === null
        ? null
        : pluginActionEnvironment.snapshot({ environmentId, input: {} }),
    ).data?.actions ?? NO_ACTIONS
  );
}

/** Whether this connection may run plugin actions now, read from the live grant. */
export function canRunPluginActionsNow(environmentId: EnvironmentId): boolean {
  return readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
}

// Execution fixes the picked environment and target, then checks the live grant before running.
export async function runPluginAction(input: {
  readonly environmentId: EnvironmentId;
  readonly action: PluginAction;
  readonly target: PluginActionTarget;
}): Promise<boolean> {
  const { action } = input;
  if (!canRunPluginActionsNow(input.environmentId)) {
    Alert.alert(`${action.title} unavailable`, "This connection cannot run plugin actions.");
    return false;
  }
  const result = await runAtomCommand(
    appAtomRegistry,
    pluginActionEnvironment.invoke,
    { environmentId: input.environmentId, input: { actionId: action.id, target: input.target } },
    { reportFailure: false },
  );
  if (result._tag === "Success") {
    if (result.value.message === null) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } else {
      Alert.alert(action.title, result.value.message);
    }
    return true;
  }
  if (isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  Alert.alert(
    `${action.title} failed`,
    error instanceof Error ? error.message : "The plugin action failed.",
  );
  return false;
}

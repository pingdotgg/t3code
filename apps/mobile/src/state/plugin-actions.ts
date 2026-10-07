import { createPluginActionEnvironmentAtoms } from "@t3tools/client-runtime/state/pluginActions";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginAction, PluginActionTarget } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { Alert } from "react-native";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";

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

/**
 * Runs a plugin action in the environment that listed it. A message from the
 * plugin or a failure is shown in an alert; a silent success taps a haptic.
 */
export async function runPluginAction(input: {
  readonly environmentId: EnvironmentId;
  readonly action: PluginAction;
  readonly target: PluginActionTarget;
}): Promise<void> {
  const { action } = input;
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
    return;
  }
  if (isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  Alert.alert(
    `${action.title} failed`,
    error instanceof Error ? error.message : "The plugin action failed.",
  );
}

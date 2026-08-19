import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginCommand, PluginCommandCatalog } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { useCallback } from "react";
import { Alert } from "react-native";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const EMPTY_PLUGIN_COMMAND_CATALOG: PluginCommandCatalog = { commands: [], generation: 0 };
const EMPTY_PLUGIN_COMMAND_CATALOG_ATOM = Atom.make(
  AsyncResult.success(EMPTY_PLUGIN_COMMAND_CATALOG),
);

export function useMobilePluginCommands(environmentId: EnvironmentId | null) {
  const catalogResult = useAtomValue(
    environmentId === null
      ? EMPTY_PLUGIN_COMMAND_CATALOG_ATOM
      : serverEnvironment.pluginCommands({ environmentId, input: {} }),
  );
  const catalog =
    Option.getOrNull(AsyncResult.value(catalogResult)) ?? EMPTY_PLUGIN_COMMAND_CATALOG;
  const invokePluginCommand = useAtomCommand(serverEnvironment.invokePluginCommand, {
    reportFailure: false,
    reportDefect: false,
  });
  const execute = useCallback(
    async (command: PluginCommand): Promise<void> => {
      if (environmentId === null) return;
      const result = await invokePluginCommand({
        environmentId,
        input: { generation: catalog.generation, id: command.id },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Command failed",
          error instanceof Error ? error.message : "The plugin command could not be completed.",
        );
        return;
      }
      Alert.alert(command.label, result.value.message);
    },
    [catalog.generation, environmentId, invokePluginCommand],
  );

  return {
    commands: catalog.commands,
    execute,
  } as const;
}

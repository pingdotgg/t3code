import { Alert } from "react-native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo } from "react";
import type { ActiveThreadSortOrder } from "@t3tools/contracts/settings";
import { resolveActiveThreadSortOrder } from "@t3tools/client-runtime/state/shared-settings";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadListV2ShelfPreferences } from "./use-thread-list-v2-shelf-preferences";

/** Reads the shared sort preference and writes changes to connected capable servers.
 * With no live target, cached settings preserve the visible order but saving is disabled.
 * Partial write failures are reported so clients do not mistake them for a completed sync.
 * The Working section beta orders the inbox itself: while it is on, the choice is hidden
 * and not applied, and it applies again when the section is off.
 */
export function useActiveThreadSort() {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const { environments } = useEnvironments();
  const { workingShelfEnabled } = useThreadListV2ShelfPreferences();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "thread sort setting");
  const targets = useMemo(
    () =>
      new Map(
        environments.flatMap((environment) => {
          const config = configs.get(environment.environmentId);
          return environment.connection.phase === "connected" &&
            config?.environment.capabilities.threadSortOrder === true
            ? [[environment.environmentId, config] as const]
            : [];
        }),
      ),
    [configs, environments],
  );
  const setOrder = useCallback(
    (activeThreadSortOrder: ActiveThreadSortOrder) => {
      void Promise.all(
        [...targets.keys()].map((environmentId) =>
          updateSettings({ environmentId, input: { patch: { activeThreadSortOrder } } }),
        ),
      ).then((results) => {
        if (results.some((result) => !AsyncResult.isSuccess(result))) {
          Alert.alert("Thread order not saved", "Could not save to all environments. Try again.");
        }
      });
    },
    [targets, updateSettings],
  );
  return {
    order: workingShelfEnabled
      ? ("manual" as const)
      : resolveActiveThreadSortOrder(targets.size > 0 ? targets : configs),
    setOrder,
    available: targets.size > 0 && !workingShelfEnabled,
  };
}

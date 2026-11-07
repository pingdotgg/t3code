import { useAtomValue } from "@effect/atom-react";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useIsFocused } from "@react-navigation/native";
import { useEffect } from "react";
import type { EnvironmentId, ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import { usageLimitsRefreshDelay } from "@t3tools/client-runtime/state/usage";
import type { AtomRegistry } from "effect/reactivity";
import { isAppActive, subscribeAppState } from "../../lib/appState";
import { instanceLimitsRefreshSelection, refreshEnvironmentLimits } from "./usageLimitsRefresh";

export function useInstanceLimitsRefresh(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind | undefined,
  visible: boolean,
) {
  const focused = useIsFocused();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const presentation = useAtomValue(environmentPresentations.presentationAtom(environmentId));
  const selectionKeyJson = JSON.stringify(
    instanceLimitsRefreshSelection(
      instanceId,
      driver,
      config?.providers ?? [],
      presentation?.connection.generation,
    ),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- quota demand follows the native panel and app lifecycle
  useEffect(() => {
    if (!visible || !focused) return;
    const selectionKey = JSON.parse(selectionKeyJson) as ReturnType<
      typeof instanceLimitsRefreshSelection
    >;
    let disposed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (!isAppActive() || pending || disposed) return;
      pending = true;
      clearTimeout(timer);
      const completed = () => {
        pending = false;
        if (!disposed)
          timer = setTimeout(
            refresh,
            Math.max(30_000, usageLimitsRefreshDelay(environmentId, selectionKey.resources)),
          );
      };
      void refreshEnvironmentLimits(registry, environmentId, {
        automatic: true,
        instanceId,
        ...(driver ? { driver } : {}),
      }).then(completed, completed);
    };
    void refresh();
    const unsubscribe = subscribeAppState(() => {
      void refresh();
    });
    return () => {
      disposed = true;
      unsubscribe();
      clearTimeout(timer);
    };
  }, [registry, environmentId, instanceId, driver, visible, focused, selectionKeyJson]);
}

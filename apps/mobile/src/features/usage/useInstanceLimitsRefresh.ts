import { useIsFocused } from "@react-navigation/native";
import { useEffect } from "react";
import type { EnvironmentId, ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { AtomRegistry } from "effect/reactivity";
import { isAppActive, subscribeAppState } from "../../lib/appState";
import { serverEnvironment } from "../../state/server";

export function useInstanceLimitsRefresh(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind | undefined,
  visible: boolean,
) {
  const focused = useIsFocused();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- quota demand follows the native panel and app lifecycle
  useEffect(() => {
    if (!visible || !focused) return;
    const refresh = () => {
      if (!isAppActive()) return;
      void runAtomCommand(
        registry,
        serverEnvironment.refreshProviders,
        { environmentId, input: { instanceId, usage: true } },
        { reportFailure: false },
      );
      if (driver)
        void runAtomCommand(
          registry,
          serverEnvironment.refreshProviders,
          { environmentId, input: { usageSources: true, usageProviders: [driver] } },
          { reportFailure: false },
        );
    };
    refresh();
    const unsubscribe = subscribeAppState(refresh);
    const timer = setInterval(refresh, 5 * 60_000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [registry, environmentId, instanceId, driver, visible, focused]);
}

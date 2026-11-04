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
    let disposed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (!isAppActive() || pending || disposed) return;
      pending = true;
      clearTimeout(timer);
      const completed = () => {
        pending = false;
        if (!disposed) timer = setTimeout(refresh, 5 * 60_000);
      };
      void Promise.all([
        runAtomCommand(
          registry,
          serverEnvironment.refreshProviders,
          { environmentId, input: { instanceId, usage: true } },
          { reportFailure: false },
        ),
        driver
          ? runAtomCommand(
              registry,
              serverEnvironment.refreshProviders,
              { environmentId, input: { usageSources: true, usageProviders: [driver] } },
              { reportFailure: false },
            )
          : undefined,
      ]).then(completed, completed);
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
  }, [registry, environmentId, instanceId, driver, visible, focused]);
}

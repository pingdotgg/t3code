import { AsyncResult } from "effect/reactivity";
import { usageRefreshDeadline, usageRefreshAccountKey } from "@t3tools/client-runtime/state/usage";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useRouterState } from "@tanstack/react-router";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { useAtomValue } from "@effect/atom-react";
import { environmentPresentations } from "../state/presentation";
import type { EnvironmentId, ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import { useAtomCommand } from "../state/use-atom-command";
import { serverEnvironment } from "../state/server";
import { useLiveRefresh } from "./useLiveRefresh";

export function useUsageLimitsRefresh(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId | null,
  enabled = true,
  driver?: ProviderDriverKind | null,
) {
  const presentation = useAtomValue(environmentPresentations.presentationAtom(environmentId));
  const connected = presentation?.connection.phase === "connected";
  const generation = presentation?.connection.generation ?? 0;
  const chatVisible = useRouterState({
    select: (state) => !isAppModalPage(state.location.pathname),
  });
  const providers = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.providers ?? [];
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  useLiveRefresh(
    () => {
      if (instanceId === null) return;
      return refresh({
        environmentId,
        input: driver ? { usage: true, usageProviders: [driver] } : { instanceId, usage: true },
      }).then((result) =>
        AsyncResult.isSuccess(result)
          ? usageRefreshDeadline(
              [
                ...result.value.providers
                  .filter((provider) =>
                    driver ? provider.driver === driver : provider.instanceId === instanceId,
                  )
                  .map((provider) => provider.usageLimits),
                ...(driver
                  ? (
                      appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))
                        ?.usageLimitSources ?? []
                    ).flatMap((source) =>
                      source.accounts
                        .filter((account) => account.driver === driver)
                        .map((account) => account.usageLimits),
                    )
                  : []),
              ],
              result.value.serverTime,
            )
          : undefined,
      );
    },
    {
      enabled: enabled && connected && chatVisible && instanceId !== null,
      key: `usage:${environmentId}:${instanceId}:${driver ?? ""}`,
      refreshKeys: [
        ...(driver
          ? [
              JSON.stringify([
                environmentId,
                driver,
                usageRefreshAccountKey(environmentId, providers, driver, null, generation),
              ]),
            ]
          : []),
        JSON.stringify([
          environmentId,
          driver,
          instanceId,
          usageRefreshAccountKey(environmentId, providers, driver, instanceId, generation),
        ]),
      ],
      refreshDeadline: (result) => (typeof result === "number" ? result : undefined),
      refreshOnShow: true,
      refreshWhileIdle: true,
    },
  );
}

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
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  useLiveRefresh(
    () => {
      return Promise.all([
        instanceId !== null
          ? refresh({ environmentId, input: { instanceId, usage: true } })
          : undefined,
        driver
          ? refresh({ environmentId, input: { usageSources: true, usageProviders: [driver] } })
          : undefined,
      ]);
    },
    {
      enabled: enabled && connected && instanceId !== null,
      key: `usage:${environmentId}:${instanceId}:${driver ?? ""}`,
      refreshOnShow: true,
      refreshWhileIdle: true,
    },
  );
}

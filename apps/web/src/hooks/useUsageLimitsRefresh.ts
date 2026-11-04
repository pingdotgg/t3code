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
      if (instanceId !== null) void refresh({ environmentId, input: { instanceId, usage: true } });
      if (driver)
        void refresh({ environmentId, input: { usageSources: true, usageProviders: [driver] } });
    },
    {
      enabled: enabled && connected && instanceId !== null,
      key: `usage:${environmentId}:${instanceId}`,
      refreshOnShow: true,
      refreshWhileIdle: true,
    },
  );
}

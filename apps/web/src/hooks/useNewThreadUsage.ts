import { useEffect, useEffectEvent, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { refreshNewThreadUsage } from "@t3tools/client-runtime/state/usage";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import type { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";

type SelectionInput = Parameters<typeof resolveNewThreadModelSelection>[0];

export function useNewThreadUsage(environmentId: EnvironmentId, input: SelectionInput | null) {
  const presentation = useAtomValue(environmentPresentations.presentationAtom(environmentId));
  const enabled = Boolean(
    input?.defaultSelection &&
    input.fallbackSelection &&
    !input.explicitSelection &&
    presentation?.connection.phase === "connected",
  );
  const key = JSON.stringify([
    environmentId,
    input?.defaultSelection,
    input?.fallbackSelection,
    input?.providers.find((provider) => provider.instanceId === input.defaultSelection?.instanceId)
      ?.auth,
  ]);
  const [completed, setCompleted] = useState<{
    key: string;
    baseline: readonly ServerProvider[];
    providers: readonly ServerProvider[];
  } | null>(null);
  const refresh = useEffectEvent(
    () =>
      input &&
      refreshNewThreadUsage({
        registry: appAtomRegistry,
        server: serverEnvironment,
        environmentId,
        input,
      }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- default selection requests quota once per draft/account, without a polling timer
  useEffect(() => {
    if (!enabled || !input) return;
    let active = true;
    const baseline = input.providers;
    void Promise.resolve(refresh()).then((providers) => {
      if (active && providers) setCompleted({ key, baseline, providers });
    });
    return () => {
      active = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- quota demand follows selection/account identity; config updates only replace its cached reading
  }, [enabled, key]);
  return {
    providers:
      completed?.key === key && completed.baseline === input?.providers
        ? completed.providers
        : (input?.providers ?? []),
    pending: enabled && completed?.key !== key,
  };
}

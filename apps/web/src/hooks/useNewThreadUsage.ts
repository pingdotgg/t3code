import { useEffect, useEffectEvent, useState } from "react";
import { flushSync } from "react-dom";
import { useAtomValue } from "@effect/atom-react";
import { refreshNewThreadUsage } from "@t3tools/client-runtime/state/usage";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import type { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";

type SelectionInput = Parameters<typeof resolveNewThreadModelSelection>[0];

export function useNewThreadUsage(
  environmentId: EnvironmentId,
  input: SelectionInput | null,
  draftKey: string,
) {
  const presentation = useAtomValue(environmentPresentations.presentationAtom(environmentId));
  const enabled = Boolean(
    input?.defaultSelection &&
    input.fallbackSelection &&
    !input.explicitSelection &&
    presentation?.connection.phase === "connected",
  );
  const key = JSON.stringify([
    draftKey,
    environmentId,
    input?.defaultSelection,
    input?.fallbackSelection,
    input?.providers
      .filter(
        (provider) =>
          provider.instanceId === input.defaultSelection?.instanceId ||
          provider.instanceId === input.fallbackSelection?.instanceId,
      )
      .map((provider) => [provider.instanceId, provider.auth]),
  ]);
  const [completed, setCompleted] = useState<{
    key: string;
    providers: readonly ServerProvider[];
  } | null>(null);
  const refresh = () =>
    input &&
    refreshNewThreadUsage({
      registry: appAtomRegistry,
      server: serverEnvironment,
      environmentId,
      input: { ...input, now: Date.now() },
    });
  const refreshOnMount = useEffectEvent(refresh);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- default selection requests quota once per draft/account, without a polling timer
  useEffect(() => {
    if (!enabled || !input) return;
    let active = true;
    void Promise.resolve(refreshOnMount()).then((providers) => {
      if (active && providers) setCompleted({ key, providers });
    });
    return () => {
      active = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- quota demand follows selection/account identity; config updates only replace its cached reading
  }, [enabled, key]);
  return {
    prepareSend: async () => {
      if (!enabled) return;
      setCompleted(null);
      const providers = await refresh();
      if (providers)
        flushSync(() =>
          setCompleted((current) =>
            current && current.key !== key ? current : { key, providers },
          ),
        );
    },
    providers: (input?.providers ?? []).map((provider) => {
      const result =
        completed?.key === key &&
        (provider.instanceId === input?.defaultSelection?.instanceId ||
          provider.instanceId === input?.fallbackSelection?.instanceId)
          ? completed.providers.find((result) => result.instanceId === provider.instanceId)
          : undefined;
      const reading = result?.usageLimits;
      if (
        result &&
        [
          [result.auth.type, provider.auth.type],
          [result.auth.email?.toLowerCase(), provider.auth.email?.toLowerCase()],
          [result.auth.workspaceId, provider.auth.workspaceId],
          [result.auth.usageRefreshKey, provider.auth.usageRefreshKey],
          [reading?.credentialFingerprint, provider.usageLimits?.credentialFingerprint],
        ].some(([next, current]) => next !== undefined && next !== current)
      )
        return result;
      const incomingFailed = reading?.unavailable?.reason === "probeFailed";
      const currentFailed = provider.usageLimits?.unavailable?.reason === "probeFailed";
      return reading &&
        (!provider.usageLimits ||
          (!incomingFailed && currentFailed) ||
          (incomingFailed === currentFailed &&
            Date.parse(reading.checkedAt) > Date.parse(provider.usageLimits.checkedAt)))
        ? { ...provider, usageLimits: reading }
        : provider;
    }),
    pending: enabled && completed?.key !== key,
  };
}

import { useAtomValue } from "@effect/atom-react";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { collectProviderUsageLimits, hasProviderUsageLimits } from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { usageLimitsBannerItem } from "./ComposerUsageLimits";

/** Keep opened data live. Retain hidden panels during reconnect; clear when quota-spending work resumes. */
export function useUsageLimitsPanel(input: {
  readonly environmentId: EnvironmentId;
  readonly threadKey: string;
  readonly panelKey: string | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providerDriver: ServerProvider["driver"] | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
}) {
  const {
    environmentId,
    threadKey,
    panelKey,
    providerInstanceId,
    providerDriver,
    providers,
    sources,
  } = input;
  const [panel, setPanel] = useState<{
    readonly key: string;
    readonly threadKey: string;
    readonly now: number;
  } | null>(null);
  if (panel !== null && panelKey !== null && panel.key !== panelKey) {
    setPanel(null);
  }
  const canCheck = useAtomValue(serverEnvironment.refreshProviders.permissionAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [checkingKey, setCheckingKey] = useState<string | null>(null);
  const report =
    panel !== null && panelKey !== null && panel.key === panelKey && providerInstanceId !== null
      ? collectProviderUsageLimits(providerInstanceId, providers, sources, panel.now)
      : null;
  const banner =
    report !== null && panel !== null
      ? // A fresh id per opening: the stack keeps the last dismissed id as "exiting".
        usageLimitsBannerItem(`usage-limits:${panel.key}:${panel.now}`, report, environmentId, () =>
          setPanel(null),
        )
      : null;
  // Intercept /usage-limits only when Limits has selected-provider data.
  const offered =
    providerDriver !== null && hasProviderUsageLimits(providerDriver, providers, sources);

  const open = useStableCallback(() => {
    const now = Date.now();
    const nextReport =
      providerInstanceId !== null && panelKey !== null
        ? collectProviderUsageLimits(providerInstanceId, providers, sources, now)
        : null;
    if (nextReport && panelKey !== null) {
      setPanel({ key: panelKey, threadKey, now });
      return true;
    }
    setPanel(null);
    toastManager.add({ type: "info", title: "Usage limits are unavailable for this provider" });
    return false;
  });
  // Runs after the refresh with this render's route and sources; the config stream lands first.
  const finishCheck = useStableCallback(
    (key: string, refreshed: readonly ServerProvider[] | null) => {
      if (key !== panelKey || providerInstanceId === null) return;
      if (refreshed === null) {
        toastManager.add({ type: "error", title: "Could not check usage limits" });
        return;
      }
      const latestSources =
        appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.usageLimitSources ??
        sources;
      const now = Date.now();
      if (collectProviderUsageLimits(providerInstanceId, refreshed, latestSources, now)) {
        setPanel({ key, threadKey, now });
        return;
      }
      toastManager.add({ type: "info", title: "Usage limits are unavailable for this provider" });
    },
  );
  const check = useStableCallback(async () => {
    if (providerInstanceId === null || panelKey === null) return;
    const key = panelKey;
    setCheckingKey(key);
    const result = await refreshUsageLimits(environmentId, () =>
      refreshProviders({ environmentId, input: {} }),
    );
    setCheckingKey((current) => (current === key ? null : current));
    finishCheck(key, result?._tag === "Success" ? result.value.providers : null);
  });
  // Async responses may clear only their originating thread's panel.
  const clearFor = useStableCallback((originThreadKey: string) =>
    setPanel((current) =>
      current !== null && current.threadKey === originThreadKey ? null : current,
    ),
  );

  const checkLimits = canCheck
    ? { pending: checkingKey !== null && checkingKey === panelKey, run: check }
    : null;

  return { banner, offered, open, clearFor, checkLimits };
}

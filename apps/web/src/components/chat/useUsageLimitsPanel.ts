import { useNowMinute } from "../../hooks/useNowMinute";
import { useUsageLimitsRefresh } from "../../hooks/useUsageLimitsRefresh";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { collectProviderUsageLimits, hasProviderUsageLimits } from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { toastManager } from "../ui/toast";
import { usageLimitsBannerItem } from "./ComposerUsageLimits";

/** Keep opened data live. Retain hidden panels during reconnect; clear when quota-spending work resumes. */
export function useUsageLimitsPanel(input: {
  readonly environmentId: EnvironmentId;
  readonly threadKey: string;
  readonly panelKey: string | null;
  readonly visible: boolean;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providerDriver: ServerProvider["driver"] | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
}) {
  const {
    environmentId,
    threadKey,
    panelKey,
    visible,
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
  const nowMinute = useNowMinute(visible && panel !== null);
  const reportNow = nowMinute ? Date.parse(`${nowMinute}:00Z`) : (panel?.now ?? 0);
  const report =
    panel !== null && panelKey !== null && panel.key === panelKey && providerInstanceId !== null
      ? collectProviderUsageLimits(providerInstanceId, providers, sources, reportNow)
      : null;
  useUsageLimitsRefresh(
    environmentId,
    providerInstanceId,
    visible && report !== null,
    providerDriver,
  );
  const banner =
    report !== null && panel !== null
      ? // A fresh id per opening: the stack keeps the last dismissed id as "exiting".
        usageLimitsBannerItem(`usage-limits:${panel.key}:${panel.now}`, report, environmentId, () =>
          setPanel(null),
        )
      : null;
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
  // Async responses may clear only their originating thread's panel.
  const clearFor = useStableCallback((originThreadKey: string) =>
    setPanel((current) =>
      current !== null && current.threadKey === originThreadKey ? null : current,
    ),
  );

  return { banner, offered, open, clearFor };
}

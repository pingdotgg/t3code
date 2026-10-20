import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  collectProviderUsageLimits,
  composerUsageLimitSources,
  hasProviderUsageLimits,
} from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { environmentPresentations } from "../../state/presentation";
import { toastManager } from "../ui/toast";
import { usageLimitsBannerItem } from "./ComposerUsageLimits";

/**
 * The open /usage-limits panel for one thread, model and turn. Only the open
 * moment is stored: the rows read live provider data, so a redeemed reset
 * credit or refreshed probe shows through. Anything that spends quota closes
 * it: a new turn from any source, or the agent resuming after an approval or
 * answered question.
 *
 * `panelKey` names that thread, model and turn. It is null while the provider
 * list or the thread itself is unavailable, such as during a reconnect; the
 * panel then stays hidden rather than being dropped.
 *
 * `sources` are the thread environment's own hubs; hubs on other connected
 * environments are added here.
 */
export function useUsageLimitsPanel(input: {
  readonly environmentId: EnvironmentId;
  readonly threadKey: string;
  readonly panelKey: string | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providerDriver: ServerProvider["driver"] | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
}) {
  const { environmentId, threadKey, panelKey, providerInstanceId, providerDriver, providers } =
    input;
  const sources = composerUsageLimitSources(
    environmentId,
    input.sources,
    useAtomValue(environmentPresentations.usageLimitSourcesByEnvironmentAtom),
  );
  const [panel, setPanel] = useState<{
    readonly key: string;
    readonly threadKey: string;
    readonly now: number;
  } | null>(null);
  // Drop the snapshot as soon as the thread or model changes so it cannot resurface stale.
  if (panel !== null && panelKey !== null && panel.key !== panelKey) {
    setPanel(null);
  }
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
  // T3 owns /usage-limits only where Limits has data for the selected provider;
  // elsewhere the name stays the provider's own and is sent through untouched.
  const offered =
    providerDriver !== null && hasProviderUsageLimits(providerDriver, providers, sources);

  // Answered locally from the last Limits snapshot; the agent never sees it.
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
  // Responses can resolve after navigating away; only the originating thread's panel clears.
  const clearFor = useStableCallback((originThreadKey: string) =>
    setPanel((current) =>
      current !== null && current.threadKey === originThreadKey ? null : current,
    ),
  );

  return { banner, offered, open, clearFor };
}

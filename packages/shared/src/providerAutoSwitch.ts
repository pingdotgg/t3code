import {
  isProviderAvailable,
  type ModelSelection,
  type ProviderAutoSwitchSettings,
  type ProviderAutoSwitchTrigger,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";

const windowApplies = (window: ServerProviderUsageWindow, model: string) =>
  window.modelIds === undefined || window.modelIds.includes(model);

/** Highest reported use, in percent, of the windows of `kind` that apply to `model`. */
export function usedPercent(
  provider: ServerProvider | undefined,
  model: string,
  kind?: Exclude<ProviderAutoSwitchTrigger, "exhausted">,
): number | null {
  const windows = (provider?.usageLimits?.windows ?? []).filter(
    (window) => (kind === undefined || window.kind === kind) && windowApplies(window, model),
  );
  return windows.length === 0 ? null : Math.max(...windows.map((window) => window.usedPercent));
}

/** Whether the selection's watched window has reached the threshold. `exhausted` only reacts to failures. */
export function autoSwitchThresholdReached(
  settings: ProviderAutoSwitchSettings,
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): boolean {
  if (settings.trigger === "exhausted") return false;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const used = usedPercent(provider, selection.model, settings.trigger);
  return used !== null && used >= settings.thresholdPercent;
}

/** A target is usable when it is enabled, reachable, and below the limit that would switch it away again. */
export function isAutoSwitchTargetUsable(
  settings: ProviderAutoSwitchSettings,
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): boolean {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (
    provider === undefined ||
    !provider.enabled ||
    !isProviderAvailable(provider) ||
    provider.status === "error" ||
    provider.status === "disabled" ||
    !provider.models.some((model) => model.slug === selection.model)
  )
    return false;
  const used = usedPercent(provider, selection.model);
  if (used !== null && used >= 100) return false;
  return !autoSwitchThresholdReached(settings, providers, selection);
}

/**
 * The route entry to switch to: the first usable one after the current provider's place in the
 * route, wrapping around. Entries on the current provider are skipped, so a route never loops.
 */
export function nextAutoSwitchTarget(
  settings: ProviderAutoSwitchSettings,
  providers: ReadonlyArray<ServerProvider>,
  current: ModelSelection,
): ModelSelection | null {
  const route = settings.route;
  const position = route.findLastIndex((entry) => entry.instanceId === current.instanceId);
  for (let offset = 1; offset <= route.length; offset++) {
    const entry = route[(position + offset + route.length) % route.length];
    if (entry === undefined || entry.instanceId === current.instanceId) continue;
    if (isAutoSwitchTargetUsable(settings, providers, entry)) return entry;
  }
  return null;
}

/** Why a run that just ended should move its thread, or null when it should stay. */
export function autoSwitchReason(input: {
  readonly settings: ProviderAutoSwitchSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selection: ModelSelection;
  readonly runStatus: string;
  readonly lastErrorClass: string | null | undefined;
}): "exhausted" | "threshold" | null {
  if (input.runStatus === "failed" && input.lastErrorClass === "usage_limit") return "exhausted";
  // Thread shells report a finished run as idle.
  return (input.runStatus === "completed" || input.runStatus === "idle") &&
    autoSwitchThresholdReached(input.settings, input.providers, input.selection)
    ? "threshold"
    : null;
}

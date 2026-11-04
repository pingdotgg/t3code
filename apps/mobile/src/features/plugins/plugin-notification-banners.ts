import type { ReceivedPluginNotification } from "@t3tools/client-runtime/state/plugin-notifications";
import type { EnvironmentId } from "@t3tools/contracts";

/** Banners waiting their turn; older ones are dropped past this. */
const MAX_QUEUED_BANNERS = 5;

export interface Banner {
  readonly environmentId: EnvironmentId;
  readonly entry: ReceivedPluginNotification;
}

/**
 * Applies one environment's frame: drops its banners the server no longer
 * retains and queues the new ones. Returns `queue` itself when nothing changed.
 */
export function queueBannerChanges(
  queue: ReadonlyArray<Banner>,
  environmentId: EnvironmentId,
  show: ReadonlyArray<ReceivedPluginNotification>,
  keep: ReadonlySet<string>,
): ReadonlyArray<Banner> {
  const kept = queue.filter(
    (banner) => banner.environmentId !== environmentId || keep.has(banner.entry.key),
  );
  if (show.length === 0 && kept.length === queue.length) return queue;
  return [...kept, ...show.map((entry) => ({ environmentId, entry }))].slice(-MAX_QUEUED_BANNERS);
}

/** Drops a removed environment's banners, which no later frame would. */
export function removeEnvironmentBanners(
  queue: ReadonlyArray<Banner>,
  environmentId: EnvironmentId,
): ReadonlyArray<Banner> {
  const kept = queue.filter((banner) => banner.environmentId !== environmentId);
  return kept.length === queue.length ? queue : kept;
}

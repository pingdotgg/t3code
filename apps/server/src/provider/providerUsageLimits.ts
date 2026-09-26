import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/** Clamp a reported utilization into the 0–100 range bars can draw. */
export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/** Session, then weekly, then monthly, with id as the tie-break. */
function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

/** A complete probe snapshot: windows in kind order, no unavailable marker. */
export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

/** Empty windows plus why this account has nothing to draw. */
export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

/**
 * A sparse update is not a full read. Keep `probeFailed` when there was no
 * snapshot, or the previous one was a failed probe or a mistaken
 * `unsupported`, so the windows do not become the last good full read. A
 * snapshot that already has no `unavailable` stays unmarked.
 */
function incompleteAfterSparseUpdate(
  previous: ServerProviderUsageLimits | undefined,
): ServerProviderUsageLimits["unavailable"] | undefined {
  if (previous !== undefined && previous.unavailable === undefined) return undefined;
  if (previous?.unavailable?.reason === "probeFailed") return previous.unavailable;
  return { reason: "probeFailed" };
}

/**
 * Fold a sparse runtime update into the limits a provider currently
 * publishes. Windows upsert by `id`; a window the update omits keeps its
 * previous values, and a window that arrives without `resetsAt` or
 * `windowDurationMins` keeps whatever the last probe resolved for it. An
 * update with no windows leaves `previous` untouched.
 *
 * An `unsupported` snapshot is not a permanent lock. A turn that reports a
 * real window clears it: a second Claude account can be mislabeled at boot
 * and still emit `rate_limit_event` utilization. The result stays
 * `probeFailed` until a full probe succeeds, so one window does not look
 * like the complete set.
 */
export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0) {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex sends this notification beside every token-usage tick, almost
  // always with unchanged numbers. Decide "nothing changed" per window on
  // the way through so the no-op case never allocates a new snapshot.
  let changed = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined) {
    return previous;
  }
  const unavailable = incompleteAfterSparseUpdate(previous);
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

/** True when a sparse update did not move any field the snapshot already has. */
function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

/**
 * Choose what to publish after a status probe finishes. A probe that failed
 * this time must not wipe bars a previous probe or a turn already
 * established, so any snapshot that has windows stays. `unsupported`
 * replaces a clean snapshot (an account that truly cannot report). It does
 * not replace windows that only exist because a turn recovered a mistaken
 * `unsupported` lock — those stay marked `probeFailed`.
 *
 * A successful probe replaces the published windows outright, including any
 * runtime update that landed while it was running. That is a deliberate
 * trade-off: the Codex and Claude reads take a few seconds at most, the
 * probe is the fresher full read in every case except that window, and the
 * per-window epoch bookkeeping needed to reconcile the two was more code
 * than the sub-second regression it prevented. The next runtime event
 * corrects it.
 */
export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (!probed?.unavailable || !published || published.windows.length === 0) {
    return probed;
  }
  if (probed.unavailable.reason === "probeFailed") {
    return published;
  }
  if (
    probed.unavailable.reason === "unsupported" &&
    published.unavailable?.reason === "probeFailed"
  ) {
    return published;
  }
  return probed;
}

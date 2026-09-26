/**
 * Cross-placement stream coordination for the terminal extension.
 *
 * The broker caps each installation at 8 concurrent plugin streams — every
 * mounted placement of the surface draws from that ONE budget, so per-view
 * feeds multiply against it: two visible placements each holding a
 * sessions/theme/appearance feed plus one pane stream already sit at 8, and
 * the first split anywhere gets rejected ("Plugin stream limit reached").
 *
 * The hub lives once per client document (module singleton in extension.tsx)
 * and spends the budget deliberately:
 *
 * - Fixed feeds (sessions/theme/appearance) are shared: refcounted by key,
 *   one subscription per key, frames fanned out to every listening view.
 *   Two placements of the same thread cost 3 streams total, not 6. A view
 *   that joins later replays the feed's current frames — the shared
 *   subscription never re-emits its snapshot, so without the replay the
 *   second placement's panel would sit on "connecting" forever.
 * - Pane output streams come from a slot pool sized to what the budget has
 *   left. Visible panes hold mandatory slots; hidden panes may keep an
 *   optional slot (parser/query continuity across a group switch) that any
 *   newly-visible pane can preempt — least-recently-demoted first — and a
 *   newly-registered fixed feed preempts the same way, so pane effects that
 *   ran first on a cold restore cannot starve the shared feeds. When the
 *   pool is exhausted by mandatory slots, acquisition fails and the caller
 *   surfaces an honest waiting state instead of a rejected subscription. A
 *   slot granted by eviction settles its admission only once the evicted
 *   pane reports its stream settled (`streamSettled`, called from the
 *   pane's pump exit) — the victim's host-level teardown resolves on the
 *   microtask queue, so an earlier subscribe would race it for the broker
 *   slot. Fixed feeds that preempt pane slots wait on the same reports
 *   before starting their driver.
 *
 * Pure coordination — no SDK imports. The view layer supplies the drivers
 * that actually open subscriptions, so the hub is unit-testable in node.
 */

/** The broker's per-installation concurrent stream cap (broker.ts `own`). */
export const BROKER_STREAM_CAP = 8;

/**
 * Frames kept per feed for late-joiner replay. At the cap the window slides
 * — the oldest frame is dropped, never the whole history. If the evicted
 * frame was the state anchor, the next join restarts the feed (its fresh
 * subscription re-anchors with a new state frame) instead of replaying
 * deltas a joiner could not reconstruct state from.
 */
export const FEED_REPLAY_MAX_FRAMES = 64;

/**
 * The broker's stream-capacity refusals. The hub models the caps
 * client-side, but the broker's accounting is authoritative: another
 * client document of the same installation, another plugin in the
 * environment, or the installation's worker process all spend the same
 * caps without appearing in this hub. A refused subscription is capacity,
 * not failure — callers wait and retry instead of surfacing an error.
 */
export function isBrokerStreamRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "Plugin stream limit reached" ||
    error.message === "Environment stream limit reached" ||
    error.message === "Worker stream limit reached"
  );
}

export type TerminalFeedStatus = "connecting" | "disconnected";

export interface TerminalSharedFeedListener<Frame> {
  /** A frame the shared subscription delivered. */
  onFrame(frame: Frame): void;
  /**
   * Subscription lifecycle: "connecting" at (re)subscription start,
   * "disconnected" when the feed ended or failed (message null when the
   * stream ended without an error).
   */
  onStatus(status: TerminalFeedStatus, message: string | null): void;
}

export interface TerminalFeedSink<Frame> {
  frame(frame: Frame): void;
  status(status: TerminalFeedStatus, message: string | null): void;
}

/**
 * Runs one shared subscription's lifetime. Retries and backoff live here —
 * the hub only starts the driver when the feed's listener count goes 0→1
 * and aborts it when it returns to 0.
 */
export type TerminalFeedDriver<Frame> = (
  sink: TerminalFeedSink<Frame>,
  signal: AbortSignal,
) => void;

/**
 * What a late joiner of an already-live feed replays to catch up with the
 * state earlier listeners hold. Without a policy the last frame alone is
 * kept — each frame supersedes the one before it (theme/appearance publish
 * whole values). With `isStateFrame`, the history resets on every state
 * frame and deltas after it accumulate, so the joiner hears
 * [snapshot … deltas] in delivery order; deltas with no state frame yet
 * carry no standalone state and are dropped.
 */
export interface TerminalFeedReplayPolicy<Frame> {
  readonly isStateFrame: (frame: Frame) => boolean;
}

/**
 * History for one delivered frame. Returns a fresh array — late joiners may
 * be mid-replay of the previous one. Returns `[]` when a delta arrives with
 * no state frame yet (it carries no standalone state). At the cap the
 * oldest frame is evicted so the window keeps sliding: the newest frames
 * survive, and the hub restarts the feed on the next join if the eviction
 * took the state anchor with it.
 */
const advanceReplay = <Frame>(
  replay: readonly Frame[],
  frame: Frame,
  policy: TerminalFeedReplayPolicy<Frame> | undefined,
): readonly Frame[] => {
  if (policy === undefined || policy.isStateFrame(frame)) return [frame];
  if (replay.length === 0) return [];
  if (replay.length >= FEED_REPLAY_MAX_FRAMES) return [...replay.slice(1), frame];
  return [...replay, frame];
};

export interface TerminalPaneLease {
  /**
   * A visible pane's slot is mandatory: never evicted. A hidden pane
   * demotes to optional — kept until a newly-visible pane needs the slot.
   */
  setPriority(mandatory: boolean): void;
  release(): void;
  /**
   * Resolves once this slot's admission is settled: immediately, or after
   * the eviction that made room finished tearing the victim's subscription
   * down (the victim's caller reports through `streamSettled`). Open the
   * stream this slot pays for only once it resolves; starting inside the
   * acquire would race the victim's host-level unsubscribe for one broker
   * slot under a full pool.
   */
  readonly admitted: Promise<void>;
  /**
   * The stream this lease admitted has fully ended — its subscription and
   * host-level teardown drained. Exactly the signal `admitted` gates on:
   * call it once when the pane's pump exits (or when a gated start never
   * ran); for a lease that was never evicted it is a no-op.
   */
  streamSettled(): void;
}

interface FixedFeed {
  /** Replaced on restart; sinks capture their own controller and go inert. */
  controller: AbortController;
  /** The driver this feed was created with — restarts reuse it verbatim. */
  readonly driver: TerminalFeedDriver<unknown>;
  readonly listeners: Set<TerminalSharedFeedListener<unknown>>;
  lastStatus: { status: TerminalFeedStatus; message: string | null } | null;
  /** Frames a late joiner replays, in delivery order. Never mutated in place. */
  replay: readonly unknown[];
  readonly replayPolicy: TerminalFeedReplayPolicy<unknown> | undefined;
}

interface PaneLeaseState {
  mandatory: boolean;
  /** When the lease last demoted to optional — eviction order. */
  demotedAt: number;
  onEvicted: () => void;
  /**
   * Evicted with the victim's teardown still draining — the promise the
   * replacement's admission (or a preempting feed's driver start) waits on,
   * resolved when the victim's caller reports `streamSettled`. A state in
   * the pool is never draining: eviction removes it first.
   */
  draining: Promise<void> | null;
}

export class TerminalStreamHub {
  readonly #feeds = new Map<string, FixedFeed>();
  readonly #panes = new Map<string, PaneLeaseState>();
  readonly #paneWaiters = new Set<() => void>();
  /** Evicted victims whose teardown is draining — resolves their replacements' admission. */
  readonly #drainResolvers = new Map<PaneLeaseState, () => void>();
  readonly #now: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  /** Slots the installation budget leaves for pane output streams. */
  paneStreamBudget(): number {
    return Math.max(0, BROKER_STREAM_CAP - this.#feeds.size);
  }

  /** Whether a new mandatory pane slot can be granted right now. */
  paneSlotAvailable(): boolean {
    return this.#panes.size < this.paneStreamBudget() || this.#evictablePane() !== null;
  }

  /**
   * Joins a shared fixed feed. The driver starts on the first listener and
   * stops when the last one leaves; frames and status fan out to every
   * listener, and a late joiner immediately hears the current status and
   * then the replayed frames (per the feed's policy) so a placement that
   * mounts while the feed is already live catches up instead of waiting
   * for the next server event. Returns the detach function (a plain
   * cleanup so React effects can hand it straight back).
   */
  acquireFixedFeed<Frame>(
    key: string,
    listener: TerminalSharedFeedListener<Frame>,
    driver: TerminalFeedDriver<Frame>,
    replayPolicy?: TerminalFeedReplayPolicy<Frame>,
  ): () => void {
    let feed = this.#feeds.get(key);
    if (feed === undefined) {
      // Fixed feeds outrank optional pane slots: on a cold restored mount
      // the pane effects run first and hidden panes take optional slots,
      // so without reclaiming, a normal eight-session restore fills every
      // slot and the sessions/theme/appearance subscriptions start over
      // the cap — the broker rejects them and New stays disabled. Evict
      // least-recently-demoted optional panes until the new feed fits;
      // mandatory slots keep their ground (a fully mandatory pool is the
      // disclosed multi-client limit, unchanged).
      const drains: Promise<void>[] = [];
      while (this.#panes.size + this.#feeds.size >= BROKER_STREAM_CAP) {
        const victim = this.#evictablePane();
        if (victim === null) break;
        // Same discipline as pane eviction: the slot is removed before
        // onEvicted runs so the synchronous teardown's release no-ops.
        this.#panes.delete(victim.key);
        drains.push(this.#beginDrain(victim.state));
        victim.state.onEvicted();
      }
      feed = {
        controller: new AbortController(),
        driver: driver as TerminalFeedDriver<unknown>,
        listeners: new Set(),
        lastStatus: null,
        replay: [],
        // The generic policy is wrapped, not cast: isStateFrame must only
        // ever see frames the driver emits through this typed call.
        replayPolicy:
          replayPolicy === undefined
            ? undefined
            : { isStateFrame: (frame: unknown) => replayPolicy.isStateFrame(frame as Frame) },
      };
      this.#feeds.set(key, feed);
      const entry = feed;
      if (drains.length > 0) {
        // Same gate as pane admission: the evicted panes' host-level
        // unsubscribes are still resolving, and starting this feed's
        // subscription now would race them for the broker slots it just
        // reclaimed.
        void Promise.all(drains).then(() => this.#startDriver(key, entry));
      } else {
        this.#startDriver(key, entry);
      }
    }
    const entry = feed;
    const bound = listener as TerminalSharedFeedListener<unknown>;
    // A slid window may have evicted the replay's state anchor. Trailing
    // deltas reconstruct nothing — restart the shared subscription instead:
    // it opens with a fresh state frame (the sessions feed snapshots at
    // establishment), re-anchoring replay for this joiner and re-syncing
    // the listeners already attached.
    const anchorEvicted =
      entry.replayPolicy !== undefined &&
      entry.replay.length > 0 &&
      !entry.replayPolicy.isStateFrame(entry.replay[0]);
    if (anchorEvicted && this.#feeds.get(key) === entry) this.#restartFeed(key, entry);
    // Replay must be a stable prefix: it is read before joining, and
    // advanceReplay always reassigns (never mutates), so a frame fanning
    // out after the join lands after the replayed history.
    const replayFrames = entry.replay;
    entry.listeners.add(bound);
    if (entry.lastStatus !== null)
      bound.onStatus(entry.lastStatus.status, entry.lastStatus.message);
    for (const frame of replayFrames) bound.onFrame(frame as Frame);
    return () => {
      if (!entry.listeners.delete(bound)) return;
      if (entry.listeners.size === 0 && this.#feeds.get(key) === entry) {
        this.#feeds.delete(key);
        entry.controller.abort();
      }
    };
  }

  /**
   * Takes a pane slot. `null` means the budget is exhausted by mandatory
   * slots — the caller shows a waiting state and retries via
   * `onPaneSlotFree`. An optional (hidden-pane) lease can be preempted at
   * any later acquisition; its `onEvicted` fires exactly once.
   */
  acquirePaneStream(
    key: string,
    options: { readonly mandatory: boolean; readonly onEvicted: () => void },
  ): TerminalPaneLease | null {
    const existing = this.#panes.get(key);
    if (existing !== undefined) {
      const wasMandatory = existing.mandatory;
      existing.mandatory = options.mandatory;
      existing.demotedAt = options.mandatory ? Number.POSITIVE_INFINITY : this.#now();
      existing.onEvicted = options.onEvicted;
      if (wasMandatory && !options.mandatory) this.#wakeWaiters();
      // A re-acquire of a held key reprioritizes in place — nothing was
      // evicted, so the admission is already settled.
      return this.#lease(key, existing, Promise.resolve());
    }
    let evicted: (() => void) | null = null;
    let victimState: PaneLeaseState | null = null;
    if (this.#panes.size >= this.paneStreamBudget()) {
      // A hidden pane has no claim on another hidden pane's continuity
      // slot — only a newly-visible pane preempts. Failing the optional
      // acquirer honestly avoids churning evictions (and subscription
      // teardowns) between panes that are never visible together.
      if (!options.mandatory) return null;
      const victim = this.#evictablePane();
      if (victim === null) return null;
      // Remove the victim and insert the new state BEFORE its onEvicted
      // runs: the callback tears down synchronously and its release must
      // no-op (the slot already belongs to THIS acquire), and a nested
      // acquire from inside the callback must see a full pool rather than
      // steal the slot back out from under this one.
      this.#panes.delete(victim.key);
      victimState = victim.state;
      evicted = victim.state.onEvicted;
    }
    const state: PaneLeaseState = {
      mandatory: options.mandatory,
      demotedAt: options.mandatory ? Number.POSITIVE_INFINITY : this.#now(),
      onEvicted: options.onEvicted,
      draining: null,
    };
    this.#panes.set(key, state);
    // The victim's subscription is tearing down now; its host-level
    // unsubscribe resolves only when the victim's pump exits, which its
    // caller reports through `streamSettled`. Hold this admission on that
    // report — an immediate subscribe would contend with the victim for
    // one broker slot under a full pool. Register the drain BEFORE the
    // eviction callback runs: a `streamSettled` reported synchronously
    // from inside `onEvicted` must find the resolver (the fixed-feed path
    // registers first the same way), or the admission would wait on a
    // report that already no-opped. An acquire that evicted nothing
    // settles at once.
    const admitted = victimState === null ? Promise.resolve() : this.#beginDrain(victimState);
    evicted?.();
    return this.#lease(key, state, admitted);
  }

  /**
   * One-shot notification that a pane slot freed (release or eviction) —
   * waiters are dropped after firing, so a caller whose acquire fails again
   * simply registers a fresh one.
   */
  onPaneSlotFree(listener: () => void): () => void {
    this.#paneWaiters.add(listener);
    return () => {
      this.#paneWaiters.delete(listener);
    };
  }

  /**
   * Runs the feed's driver against its current controller. The sink captures
   * that controller, so a restart (or the last detach) renders the previous
   * sink inert — an in-flight frame from the old subscription can no longer
   * advance the new replay window.
   */
  #startDriver(key: string, feed: FixedFeed): void {
    if (feed.controller.signal.aborted || this.#feeds.get(key) !== feed) return;
    const controller = feed.controller;
    const sink: TerminalFeedSink<unknown> = {
      frame: (frame) => {
        if (controller.signal.aborted) return;
        feed.replay = advanceReplay(feed.replay, frame, feed.replayPolicy);
        for (const listener of feed.listeners) listener.onFrame(frame);
      },
      status: (status, message) => {
        if (controller.signal.aborted) return;
        feed.lastStatus = { status, message };
        for (const listener of feed.listeners) listener.onStatus(status, message);
      },
    };
    feed.driver(sink, controller.signal);
  }

  /**
   * Tears the feed's subscription down and starts it again. The old
   * subscription's broker-side teardown resolves on the microtask queue, so
   * the replacement starts one microtask later — overlapping the two would
   * transiently exceed the stream cap.
   */
  #restartFeed(key: string, feed: FixedFeed): void {
    feed.controller.abort();
    feed.controller = new AbortController();
    feed.replay = [];
    queueMicrotask(() => this.#startDriver(key, feed));
  }

  #lease(key: string, state: PaneLeaseState, admitted: Promise<void>): TerminalPaneLease {
    const hub = this;
    return {
      admitted,
      setPriority(mandatory: boolean) {
        if (hub.#panes.get(key) !== state) return;
        const wasMandatory = state.mandatory;
        state.mandatory = mandatory;
        state.demotedAt = mandatory ? Number.POSITIVE_INFINITY : hub.#now();
        // Demotion creates preemptable capacity: a pane that failed to
        // acquire against a fully-mandatory pool can now evict this slot,
        // so it must hear about the transition (release() already wakes).
        if (wasMandatory && !mandatory) hub.#wakeWaiters();
      },
      release() {
        if (hub.#panes.get(key) !== state) return;
        hub.#panes.delete(key);
        hub.#wakeWaiters();
      },
      streamSettled() {
        const settle = hub.#drainResolvers.get(state);
        if (settle === undefined) return;
        hub.#drainResolvers.delete(state);
        state.draining = null;
        settle();
      },
    };
  }

  /**
   * Marks an evicted victim's teardown as draining and returns the promise
   * its replacement's admission (or a preempting feed's driver start)
   * waits on. The victim's caller resolves it with `streamSettled()` once
   * its pump has fully exited; a state that was never evicted has none.
   */
  #beginDrain(state: PaneLeaseState): Promise<void> {
    if (state.draining !== null) return state.draining;
    let settle!: () => void;
    state.draining = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#drainResolvers.set(state, settle);
    return state.draining;
  }

  #evictablePane(): { key: string; state: PaneLeaseState } | null {
    let victim: { key: string; state: PaneLeaseState } | null = null;
    for (const [key, state] of this.#panes) {
      if (state.mandatory) continue;
      if (victim === null || state.demotedAt < victim.state.demotedAt) victim = { key, state };
    }
    return victim;
  }

  #wakeWaiters() {
    const waiters = [...this.#paneWaiters];
    this.#paneWaiters.clear();
    for (const waiter of waiters) waiter();
  }
}

import * as NodeUtil from "node:util";

import {
  CONTRIBUTION_STATUS_KEY_MAX_LENGTH,
  CONTRIBUTION_STATUS_MAX_ITEMS,
  CONTRIBUTION_STATUS_MAX_ITEMS_PER_SOURCE,
  CONTRIBUTION_STATUS_MAX_PLUGIN_ITEMS,
  CONTRIBUTION_STATUS_MAX_PLUGIN_SOURCES_PER_THREAD,
  CONTRIBUTION_STATUS_MAX_PLUGIN_THREADS,
  CONTRIBUTION_STATUS_MAX_SOURCES_PER_THREAD,
  CONTRIBUTION_STATUS_MAX_THREADS,
  CONTRIBUTION_STATUS_TEXT_MAX_LENGTH,
  CONTRIBUTION_STATUS_TOOLTIP_MAX_LENGTH,
  type ContributionStatusItem,
  type ContributionStatusSnapshot,
  type ContributionStatusSource,
  type ContributionStatusTone,
  contributionStatusSourceKey,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

/**
 * One producer's statuses. A handle writes to at most one thread at a time and
 * is retired when the scope that opened it closes, clearing what it set. After
 * another handle with the same kind of source binds the same thread, this one
 * is stale: its writes are ignored until it binds again, so a late update from
 * a replaced provider session never reaches the replacement's statuses.
 */
export interface ContributionStatusSourceHandle {
  /**
   * Moves this handle to `threadId`, clearing what it set on its previous
   * thread. Rebinding the thread it still owns keeps its items; binding a
   * thread where another provider session owns the provider entry takes that
   * entry over and clears its items.
   */
  readonly bindThread: (threadId: ThreadId | null) => Effect.Effect<void>;
  /** Sets or replaces `key`. Text that is empty after normalization clears the key. */
  readonly set: (input: {
    readonly key: string;
    readonly text: string;
    readonly tone?: ContributionStatusTone;
    readonly tooltip?: string;
  }) => Effect.Effect<void>;
  readonly clear: (key: string) => Effect.Effect<void>;
  readonly clearAll: Effect.Effect<void>;
  /** What this handle currently shows, as stored: admitted, normalized, and capped. */
  readonly items: Effect.Effect<ReadonlyArray<ContributionStatusItem>>;
}

export interface ContributionStatusStoreShape {
  readonly openSource: (
    source: ContributionStatusSource,
  ) => Effect.Effect<ContributionStatusSourceHandle, never, Scope.Scope>;
  readonly snapshot: Effect.Effect<ContributionStatusSnapshot>;
  /** Latest snapshot plus later full replacements; a slow subscriber only skips intermediate ones. */
  readonly subscribe: Effect.Effect<
    {
      readonly latest: ContributionStatusSnapshot;
      readonly changes: Stream.Stream<ContributionStatusSnapshot>;
    },
    never,
    Scope.Scope
  >;
}

const emptySnapshot: ContributionStatusSnapshot = { entries: [] };

const noopHandle: ContributionStatusSourceHandle = {
  bindThread: () => Effect.void,
  set: () => Effect.void,
  clear: () => Effect.void,
  clearAll: Effect.void,
  items: Effect.succeed([]),
};

/**
 * Thread statuses produced by live provider sessions. The default drops every
 * update so adapters construct without it in tests; the live layer must be the
 * same reference the WebSocket server reads, so layer memoization shares one
 * store between producers and subscribers.
 */
export class ContributionStatusStore extends Context.Reference<ContributionStatusStoreShape>(
  "@t3tools/provider-core/server/ContributionStatusStore",
  {
    defaultValue: () => ({
      openSource: () => Effect.succeed(noopHandle),
      snapshot: Effect.succeed(emptySnapshot),
      subscribe: Effect.succeed({ latest: emptySnapshot, changes: Stream.empty }),
    }),
  },
) {}

// Line breaks, tabs, other C0/C1 controls, DEL, and Unicode line/paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
// eslint-disable-next-line no-control-regex -- matches the control characters on purpose, as above
const HAS_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Keys are identities, not display text, so they are never rewritten: two
 * different keys must never collide. A key that is empty, longer than the
 * contract allows, or contains a control character or lone UTF-16 surrogate
 * is rejected on set and clear alike.
 */
export const isValidContributionStatusKey = (key: string) =>
  key.length > 0 &&
  key.length <= CONTRIBUTION_STATUS_KEY_MAX_LENGTH &&
  key.isWellFormed() &&
  !HAS_CONTROL_CHARACTER.test(key);

/**
 * Producer text as one plain line: terminal styling removed, lone surrogates
 * replaced with U+FFFD, controls turned into spaces, whitespace collapsed, and
 * at most `maxLength` UTF-16 units without splitting a surrogate pair. A
 * truncated value ends in `…`.
 */
export function normalizeContributionStatusText(raw: string, maxLength: number): string {
  const text = NodeUtil.stripVTControlCharacters(raw.toWellFormed())
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  let truncated = "";
  for (const codePoint of text) {
    if (truncated.length + codePoint.length > maxLength - 1) break;
    truncated += codePoint;
  }
  return `${truncated.trimEnd()}…`;
}

interface SourceSlot {
  readonly generation: number;
  readonly source: ContributionStatusSource;
  readonly items: Map<string, ContributionStatusItem>;
}

/**
 * Which handles compete for one entry on a thread. A thread hosts one provider
 * session at a time, so every provider-session source shares a slot and a new
 * session takes the old one over; each plugin gets its own slot.
 */
const slotKey = (source: ContributionStatusSource) =>
  source.kind === "plugin" ? contributionStatusSourceKey(source) : source.kind;

/** Capacity pools: plugins count only against their own, so they never crowd out provider statuses. */
const poolLimits = (source: ContributionStatusSource) =>
  source.kind === "plugin"
    ? {
        sources: CONTRIBUTION_STATUS_MAX_PLUGIN_SOURCES_PER_THREAD,
        threads: CONTRIBUTION_STATUS_MAX_PLUGIN_THREADS,
        items: CONTRIBUTION_STATUS_MAX_PLUGIN_ITEMS,
      }
    : {
        sources: CONTRIBUTION_STATUS_MAX_SOURCES_PER_THREAD,
        threads: CONTRIBUTION_STATUS_MAX_THREADS,
        items: CONTRIBUTION_STATUS_MAX_ITEMS,
      };

const sameItem = (left: ContributionStatusItem | undefined, right: ContributionStatusItem) =>
  left !== undefined &&
  left.text === right.text &&
  left.tone === right.tone &&
  left.tooltip === right.tooltip;

const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const sourceRank = (source: ContributionStatusSource) =>
  source.kind === "provider-session" ? 0 : 1;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("contributions.status.make")(function* () {
  const threads = new Map<ThreadId, Map<string, SourceSlot>>();
  const changes = yield* PubSub.sliding<ContributionStatusSnapshot>(1);
  const mutex = yield* Semaphore.make(1);
  let nextGeneration = 0;

  /**
   * Binding a thread only records ownership; capacity is taken by the first
   * visible item and returned by the last clear, so silent producers never
   * crowd out ones that show something, and a rejected producer's later set
   * is admitted once capacity frees up. Each pool's caps count only its own
   * sources.
   */
  const admitsNewItem = (threadId: ThreadId, slot: SourceSlot) => {
    if (slot.items.size >= CONTRIBUTION_STATUS_MAX_ITEMS_PER_SOURCE) return false;
    const limits = poolLimits(slot.source);
    const samePool = (other: SourceSlot) =>
      (other.source.kind === "plugin") === (slot.source.kind === "plugin");
    let items = 0;
    let visibleThreads = 0;
    for (const slots of threads.values()) {
      let visible = false;
      for (const other of slots.values()) {
        if (!samePool(other)) continue;
        items += other.items.size;
        visible ||= other.items.size > 0;
      }
      if (visible) visibleThreads += 1;
    }
    if (items >= limits.items) return false;
    if (slot.items.size > 0) return true;
    let visibleSources = 0;
    for (const other of threads.get(threadId)?.values() ?? []) {
      if (samePool(other) && other.items.size > 0) visibleSources += 1;
    }
    if (visibleSources >= limits.sources) return false;
    return visibleSources > 0 || visibleThreads < limits.threads;
  };

  const currentSnapshot = (): ContributionStatusSnapshot => ({
    entries: Array.from(threads.keys())
      .toSorted(compareStrings)
      .flatMap((threadId) =>
        Array.from(threads.get(threadId)?.values() ?? [])
          .filter((slot) => slot.items.size > 0)
          .toSorted(
            (left, right) =>
              sourceRank(left.source) - sourceRank(right.source) ||
              compareStrings(
                contributionStatusSourceKey(left.source),
                contributionStatusSourceKey(right.source),
              ),
          )
          .map((slot) => ({
            threadId,
            source: slot.source,
            items: Array.from(slot.items.values()).toSorted((left, right) =>
              compareStrings(left.key, right.key),
            ),
          })),
      ),
  });

  /** Runs `mutate` under the store lock and publishes once when it reports a visible change. */
  const update = (mutate: () => boolean) =>
    mutex.withPermits(1)(
      Effect.suspend(() =>
        mutate() ? PubSub.publish(changes, currentSnapshot()).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  const openSource: ContributionStatusStoreShape["openSource"] = (source) =>
    Effect.gen(function* () {
      let threadId: ThreadId | null = null;
      let generation = 0;
      let retired = false;

      const slotId = slotKey(source);

      /** The slot this handle still owns, or undefined when it is unbound, replaced, or retired. */
      const ownedSlot = () => {
        if (retired || threadId === null) return undefined;
        const slot = threads.get(threadId)?.get(slotId);
        return slot?.generation === generation ? slot : undefined;
      };

      const release = () => {
        const slot = ownedSlot();
        if (slot === undefined || threadId === null) return false;
        const slots = threads.get(threadId);
        slots?.delete(slotId);
        if (slots?.size === 0) threads.delete(threadId);
        return slot.items.size > 0;
      };

      const handle: ContributionStatusSourceHandle = {
        bindThread: (nextThreadId) =>
          update(() => {
            if (retired) return false;
            if (nextThreadId !== null && nextThreadId === threadId && ownedSlot() !== undefined) {
              return false;
            }
            const released = release();
            threadId = nextThreadId;
            if (nextThreadId === null) return released;
            let slots = threads.get(nextThreadId);
            if (slots === undefined) {
              slots = new Map();
              threads.set(nextThreadId, slots);
            }
            const replaced = slots.get(slotId);
            generation = ++nextGeneration;
            slots.set(slotId, { generation, source, items: new Map() });
            return released || (replaced !== undefined && replaced.items.size > 0);
          }),
        set: (input) =>
          update(() => {
            const slot = ownedSlot();
            const key = input.key;
            if (slot === undefined || threadId === null || !isValidContributionStatusKey(key))
              return false;
            const text = normalizeContributionStatusText(
              input.text,
              CONTRIBUTION_STATUS_TEXT_MAX_LENGTH,
            );
            if (text.length === 0) return slot.items.delete(key);
            const previous = slot.items.get(key);
            if (previous === undefined && !admitsNewItem(threadId, slot)) return false;
            const tooltip =
              input.tooltip === undefined
                ? ""
                : normalizeContributionStatusText(
                    input.tooltip,
                    CONTRIBUTION_STATUS_TOOLTIP_MAX_LENGTH,
                  );
            const item: ContributionStatusItem = {
              key,
              text,
              ...(input.tone === undefined || input.tone === "neutral" ? {} : { tone: input.tone }),
              ...(tooltip.length === 0 ? {} : { tooltip }),
            };
            if (sameItem(previous, item)) return false;
            slot.items.set(key, item);
            return true;
          }),
        clear: (key) =>
          update(() => {
            const slot = ownedSlot();
            if (slot === undefined || !isValidContributionStatusKey(key)) return false;
            return slot.items.delete(key);
          }),
        clearAll: update(() => {
          const slot = ownedSlot();
          if (slot === undefined || slot.items.size === 0) return false;
          slot.items.clear();
          return true;
        }),
        items: mutex.withPermits(1)(
          Effect.sync(() => Array.from(ownedSlot()?.items.values() ?? [])),
        ),
      };

      yield* Effect.addFinalizer(() =>
        update(() => {
          const released = release();
          retired = true;
          return released;
        }),
      );
      return handle;
    });

  return ContributionStatusStore.of({
    openSource,
    snapshot: mutex.withPermits(1)(Effect.sync(currentSnapshot)),
    // Subscribes under the lock so no change lands between the snapshot and the stream.
    subscribe: mutex.withPermits(1)(
      Effect.map(PubSub.subscribe(changes), (subscription) => ({
        latest: currentSnapshot(),
        changes: Stream.fromSubscription(subscription),
      })),
    ),
  });
});

export const layer = Layer.effect(ContributionStatusStore, make());

/** The `subscribeContributionStatus` stream: the current snapshot, then each replacement. */
export const subscriptionStream = (store: ContributionStatusStoreShape) =>
  Stream.unwrap(
    Effect.map(store.subscribe, ({ latest, changes }) =>
      Stream.concat(Stream.make(latest), changes),
    ),
  );

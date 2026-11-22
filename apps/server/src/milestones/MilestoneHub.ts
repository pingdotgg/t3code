import {
  type MilestoneEvent,
  type MilestoneFilter,
  type MilestoneId,
  milestoneMatches,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

// Enough for a client that was away for a while to catch up; older news is in the stores.
const KEPT = 1_000;
// Ids outlive the events they name, so a late repeat of an evicted milestone is still one.
const IDS_KEPT = 4 * KEPT;
// A subscriber this far behind loses its oldest milestones, not the server's memory.
const SUBSCRIBER_BACKLOG = 256;
const RECENT_LIMIT = 200;

/** A milestone and the cursor that reads on after it. */
export interface PositionedMilestone {
  readonly event: MilestoneEvent;
  readonly cursor: string;
}

/**
 * Where a cursor read starts. `null` starts from now. A cursor from before a restart or no longer
 * kept starts at the oldest kept milestone; `maxAgeMs` skips those older than that.
 */
export interface MilestoneReadOptions {
  readonly cursor: string | null;
  readonly maxAgeMs?: number | undefined;
  readonly filter?: MilestoneFilter | undefined;
}

/** What a follower reads after its start: a milestone, a position passed without one, or a gap. */
export type MilestoneFollowItem =
  | ({ readonly _tag: "Milestone" } & PositionedMilestone)
  | { readonly _tag: "Position"; readonly cursor: string }
  | { readonly _tag: "Gap"; readonly cursor: string };

export class MilestoneHub extends Context.Service<
  MilestoneHub,
  {
    /** Publishing an id seen before does nothing, so a feeder may repeat itself. */
    readonly publish: (event: MilestoneEvent) => Effect.Effect<void>;
    /**
     * Milestones published from now on that match `filter`. Subscribed when this runs, so a caller
     * catching up subscribes first, then reads `recent`, and drops ids it already has.
     */
    readonly subscribe: (
      filter?: MilestoneFilter,
    ) => Effect.Effect<Stream.Stream<MilestoneEvent>, never, Scope.Scope>;
    /**
     * Kept milestones, oldest first: those after `sinceId`, or the newest. `truncated` says the
     * answer is incomplete: `sinceId` is no longer kept, or `limit` cut it short.
     */
    readonly recent: (options?: {
      readonly sinceId?: MilestoneId | undefined;
      readonly limit?: number | undefined;
      readonly filter?: MilestoneFilter | undefined;
    }) => Effect.Effect<{
      readonly events: ReadonlyArray<MilestoneEvent>;
      readonly truncated: boolean;
    }>;
    /**
     * Matching milestones after a cursor, at most `limit`. `cursor` reads on from there: after the
     * last one returned when `hasMore`, otherwise from now. `truncated` says some were skipped.
     */
    readonly read: (options: MilestoneReadOptions & { readonly limit: number }) => Effect.Effect<{
      readonly events: ReadonlyArray<PositionedMilestone>;
      readonly cursor: string;
      readonly truncated: boolean;
      readonly hasMore: boolean;
    }>;
    /** The milestones `read` would return, then live ones, each once. */
    readonly follow: (options: MilestoneReadOptions) => Effect.Effect<
      {
        readonly cursor: string;
        readonly truncated: boolean;
        readonly items: Stream.Stream<MilestoneFollowItem>;
      },
      never,
      Scope.Scope
    >;
  }
>()("t3/milestones/MilestoneHub") {}

interface Kept {
  readonly event: MilestoneEvent;
  readonly seq: number;
}

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.sliding<Kept>(SUBSCRIBER_BACKLOG);
  const kept: Array<Kept> = [];
  const seen = new Set<MilestoneId>();
  let seq = 0;
  // Sequence numbers restart with the server; the epoch tells an old cursor from a new one.
  const epoch = (yield* Clock.currentTimeMillis).toString(36);
  const cursorAt = (at: number) => `${epoch}.${at}`;
  const seqOf = (cursor: string) => {
    const [cursorEpoch, at] = cursor.split(".");
    const value = Number(at);
    return cursorEpoch === epoch && Number.isSafeInteger(value) && value >= 0 && value <= seq
      ? value
      : undefined;
  };

  const remember = (event: MilestoneEvent) => {
    if (seen.has(event.id)) return undefined;
    seen.add(event.id);
    if (seen.size > IDS_KEPT) seen.delete(seen.values().next().value!);
    const entry = { event, seq: ++seq };
    kept.push(entry);
    if (kept.length > KEPT) kept.shift();
    return entry;
  };

  // The kept milestones after the cursor, and whether milestones after it were skipped.
  const after = (options: MilestoneReadOptions, now: number) => {
    if (options.cursor === null) return { entries: [], truncated: false };
    const from = seqOf(options.cursor);
    const oldest = kept[0]?.seq ?? seq + 1;
    let entries = from === undefined ? kept : kept.filter((entry) => entry.seq > from);
    let truncated = from === undefined || from < oldest - 1;
    if (options.maxAgeMs !== undefined) {
      // Kept in publication order, which `occurredAt` need not follow, so each one is checked.
      const floor = now - options.maxAgeMs;
      const young = entries.filter((entry) => Date.parse(entry.event.occurredAt) >= floor);
      truncated ||= young.length < entries.length;
      entries = young;
    }
    return { entries, truncated };
  };

  const positioned = (entry: Kept): PositionedMilestone => ({
    event: entry.event,
    cursor: cursorAt(entry.seq),
  });

  const subscribe = Effect.fn("MilestoneHub.subscribe")(function* (filter?: MilestoneFilter) {
    const subscription = yield* PubSub.subscribe(pubsub);
    return Stream.fromSubscription(subscription).pipe(
      Stream.map((entry) => entry.event),
      Stream.filter((event) => milestoneMatches(event, filter)),
    );
  });

  const recent: MilestoneHub["Service"]["recent"] = Effect.fn("MilestoneHub.recent")(function* (
    options = {},
  ) {
    const limit = Math.max(1, Math.min(options.limit ?? RECENT_LIMIT, KEPT));
    const at =
      options.sinceId === undefined
        ? -1
        : kept.findIndex((entry) => entry.event.id === options.sinceId);
    const gap = options.sinceId !== undefined && at === -1;
    const matching = kept
      .slice(at + 1)
      .map((entry) => entry.event)
      .filter((event) => milestoneMatches(event, options.filter));
    // Paging forward from a known id; otherwise the newest, as there is no place to start.
    const events =
      options.sinceId !== undefined && !gap ? matching.slice(0, limit) : matching.slice(-limit);
    return yield* Effect.succeed({ events, truncated: gap || events.length < matching.length });
  });

  const read: MilestoneHub["Service"]["read"] = Effect.fn("MilestoneHub.read")(function* (options) {
    const from = after(options, yield* Clock.currentTimeMillis);
    const matching = from.entries.filter((entry) => milestoneMatches(entry.event, options.filter));
    const events = matching.slice(0, Math.max(1, options.limit));
    const hasMore = events.length < matching.length;
    return {
      events: events.map(positioned),
      cursor: hasMore ? cursorAt(events.at(-1)!.seq) : cursorAt(seq),
      truncated: from.truncated,
      hasMore,
    };
  });

  return MilestoneHub.of({
    publish: Effect.fn("MilestoneHub.publish")(function* (event) {
      const entry = remember(event);
      if (entry === undefined) return;
      yield* PubSub.publish(pubsub, entry);
    }),
    subscribe,
    recent,
    read,
    follow: Effect.fn("MilestoneHub.follow")(function* (options) {
      // Subscribed before reading the buffer, so nothing published in between is lost.
      const live = Stream.fromSubscription(yield* PubSub.subscribe(pubsub));
      const caught = yield* read({ ...options, limit: KEPT });
      const first = caught.events[0];
      let last = seqOf(caught.cursor)!;
      const items = live.pipe(
        Stream.flatMap((entry) => {
          if (entry.seq <= last) return Stream.empty;
          // A follower that fell behind the subscriber backlog lost the milestones in between.
          const gap = entry.seq > last + 1;
          last = entry.seq;
          const item: MilestoneFollowItem = milestoneMatches(entry.event, options.filter)
            ? { _tag: "Milestone", ...positioned(entry) }
            : { _tag: "Position", cursor: cursorAt(entry.seq) };
          return Stream.fromIterable(
            gap ? [{ _tag: "Gap" as const, cursor: cursorAt(entry.seq - 1) }, item] : [item],
          );
        }),
      );
      return {
        // The position before the first replayed milestone, which each one then advances.
        cursor: first === undefined ? caught.cursor : cursorAt(seqOf(first.cursor)! - 1),
        truncated: caught.truncated,
        items: Stream.fromIterable<MilestoneFollowItem>([
          ...caught.events.map((event): MilestoneFollowItem => ({ _tag: "Milestone", ...event })),
          // Replay checked past its last match; told after it, so no client skips a replayed one.
          ...(first !== undefined && caught.events.at(-1)!.cursor !== caught.cursor
            ? [{ _tag: "Position" as const, cursor: caught.cursor }]
            : []),
        ]).pipe(Stream.concat(items)),
      };
    }),
  });
});

export const layer = Layer.effect(MilestoneHub, make);

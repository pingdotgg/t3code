import type { HttpEffect } from "alchemy/Http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Scope } from "effect/Scope";
import type * as Stream from "effect/Stream";
import * as Aggregate from "./Aggregate.ts";
import type { Plan } from "./Backfill.ts";
import type { ReplayInput, ReplayResult } from "./CatchUp.ts";
import { ModelHostedTwice } from "./DefinitionError.ts";
import { DefinitionError } from "./internal.ts";
import type * as Policy from "./Policy.ts";
import type * as Projection from "./Projection.ts";
import type * as DomainStream from "./Stream.ts";
import { TraceJson } from "./Telemetry.ts";
import type * as View from "./View.ts";

/**
 * Capture the services `R` for later use, minus the `Scope`: a captured
 * construction-time scope must never replace the scope of a later request or
 * event (finalizers would attach to the wrong lifetime, and on workerd the
 * work would be pinned to another request's I/O context). Platforms that host
 * a model call this when they are built.
 */
export const captureContext = <R = never>(): Effect.Effect<
  Context.Context<Exclude<R, Scope>>,
  never,
  R
> =>
  Effect.map(
    Effect.context<R>(),
    (context) => Context.omit(Scope)(context) as Context.Context<Exclude<R, Scope>>,
  );

/**
 * Everything a platform persists or sends is plain JSON. The kernel owns the
 * schemas; platforms only move and store these values.
 */
export type Json = unknown;

/**
 * An event envelope in JSON form. `at` is epoch milliseconds.
 */
export const EnvelopeJson = Schema.Struct({
  ...Aggregate.Envelope.fields,
  at: Schema.Number,
  /** Absent on events stored before correlation ids: the command id stands in. */
  correlationId: Schema.optionalKey(Schema.String),
  /** The span that committed the event, so its reactions continue or link to it. */
  trace: Schema.optionalKey(TraceJson),
});
export type EnvelopeJson = typeof EnvelopeJson.Type;

/**
 * A committed event as stored by an aggregate.
 */
export interface StoredEvent {
  readonly event: Json;
  readonly envelope: EnvelopeJson;
}

/**
 * A unit of work routed from one host to another: an event (from an aggregate
 * or a view) to a view or policy. Deliveries are at least once; targets drop
 * duplicates by `(source, seq)`. Platforms must deliver in order per
 * `(source, target)`.
 */
export interface Delivery {
  readonly target: {
    readonly kind: "view" | "policy" | "projection";
    readonly name: string;
    /** The consumer's generation (see `Kernel.generationOf`), when it has been rebuilt. */
    readonly generation?: number;
    /** Rebuilt in the storage it had (see `Kernel.inPlace`): its id says `@` for `#`. */
    readonly inPlace?: boolean;
  };
  /** The target partition: a key's id, or the source stream for an unkeyed policy. */
  readonly key: string;
  /** Named routes (from `keyOf`) the event takes into this key; absent for the default route. */
  readonly routes?: ReadonlyArray<string>;
  /** The source stream, e.g. `Account/a-1` or `Statement/a-1`. */
  readonly source: string;
  /** The event's sequence number in its source stream. */
  readonly seq: number;
  /** The aggregate or view that produced the event. */
  readonly origin: string;
  readonly tag: string;
  readonly event: Json;
  readonly envelope: EnvelopeJson;
  /** For an event from a view: the view's encoded state after it. */
  readonly state?: Json;
  /**
   * History: seeded (story `given`) or replayed to a consumer added after the
   * event (see `CatchUp`). Views and projections apply it, policies ignore it.
   */
  readonly history?: boolean;
}

/**
 * A client's live read (`watch` or `events`) of one key, in JSON form. A
 * platform that pushes keeps it with the connection (on a WebSocket's
 * attachment, so a hibernated object can resume pushing) and asks the kit's
 * `push` what to send after each commit.
 */
export const Subscription = Schema.Struct({
  /** The client's request id, echoed as is (the client matches it by identity). */
  requestId: Schema.Union([Schema.String, Schema.Number]),
  mode: Schema.Literals(["watch", "events"]),
  /** The client's filter: it narrows what a permitted read sends. */
  where: Schema.optionalKey(Schema.Unknown),
  /** The context the read's middleware provided (see `Domain.RequestContext`), for `validate`. */
  context: Schema.Record(Schema.String, Schema.Unknown),
  /** Progress: the last state version (`watch`) or event `seq` (`events`) sent. */
  cursor: Schema.Number,
  /** Set when the read was refused before reaching the key: the encoded `Exit` to send. */
  refused: Schema.optionalKey(Schema.Unknown),
  /** `events` only: set once the `CaughtUp` frame after the read's history was sent. */
  caughtUpSent: Schema.optionalKey(Schema.Boolean),
});
export type Subscription = typeof Subscription.Type;

/**
 * What to send a subscriber, from a kit's `push`.
 */
export interface Push {
  /** Effect RPC messages (a `Chunk`, then an `Exit` if the read ended), in JSON form. */
  readonly messages: ReadonlyArray<Json>;
  /** The subscription with its progress after these messages. */
  readonly subscription: Subscription;
  /** `validate` rejected the read: send the messages, then close the connection. */
  readonly done: boolean;
}

/**
 * Input to {@link AggregateKit.handle}.
 */
export interface HandleInput {
  readonly id: string;
  /** The stored state, or `null` for an instance that has never committed. */
  readonly state: Json;
  readonly version: number;
  readonly command: Json;
  readonly commandId: string;
  /** The context the command was sent with (see `Domain.RequestContext`). */
  readonly context: Readonly<Record<string, Json>>;
  /** Epoch milliseconds. */
  readonly now: number;
  /** The flow the command belongs to; the command id when it starts one. */
  readonly correlationId?: string;
  /** The span that sent the command. */
  readonly trace?: TraceJson;
  /** Link to `trace` instead of continuing it. */
  readonly link?: boolean;
}

/**
 * Result of {@link AggregateKit.handle}.
 */
export type HandleResult =
  | { readonly _tag: "Rejected"; readonly rejection: Json }
  | {
      readonly _tag: "Accepted";
      readonly state: Json;
      readonly version: number;
      readonly events: ReadonlyArray<StoredEvent>;
      readonly reply: Json;
      readonly deliveries: ReadonlyArray<Delivery>;
    };

/**
 * The receipt of an accepted command, in JSON form.
 */
export interface ReceiptJson {
  readonly stream: string;
  readonly version: number;
  readonly events: ReadonlyArray<Json>;
  readonly reply: Json;
}

/**
 * Result of {@link AggregateStore.send}.
 */
export type SendResult =
  | { readonly _tag: "Rejected"; readonly rejection: Json }
  | { readonly _tag: "Accepted"; readonly receipt: ReceiptJson };

/**
 * The kernel for one aggregate type, handed to a platform.
 */
export interface AggregateKit {
  readonly name: string;
  /**
   * Decide, evolve, reply and route, purely. Throws only on a bug (an evolve
   * guard, an undecodable value); a platform turns that into a defect.
   */
  readonly handle: (input: HandleInput) => Effect.Effect<HandleResult>;
  /**
   * Fold already-decided events into state and route them, without running
   * `decide`. Used to seed history (story `given`).
   */
  readonly seed: (input: SeedInput) => Effect.Effect<SeedResult>;
  /** Route a delivery produced by `handle` to its target's host. */
  readonly deliver: (delivery: Delivery) => Effect.Effect<void>;
  /** The views and projections that consume this aggregate, by `CatchUp.targetId`. */
  readonly targets: ReadonlyArray<string>;
  /** Whether each key of a consumer it feeds hears only from the instance with its own id. */
  readonly consumerSingleSource: (target: string) => boolean;
  /** Route stored events to the consumers lagging behind them (see `CatchUp`). */
  readonly replay: (input: ReplayInput<StoredEvent>) => Effect.Effect<ReplayResult>;
  /**
   * What a subscriber of instance `id` receives, given its current state and
   * the events committed since (at least those after the subscription's cursor).
   */
  readonly push: (
    id: string,
    subscription: Subscription,
    current: { readonly state: Json; readonly version: number },
    events: ReadonlyArray<StoredEvent>,
  ) => Effect.Effect<Push>;
}

/**
 * Input to {@link AggregateKit.seed}.
 */
export interface SeedInput {
  readonly id: string;
  readonly state: Json;
  readonly version: number;
  readonly events: ReadonlyArray<Json>;
  readonly commandId: string;
  readonly now: number;
}

/**
 * Result of {@link AggregateKit.seed}.
 */
export interface SeedResult {
  readonly state: Json;
  readonly version: number;
  readonly events: ReadonlyArray<StoredEvent>;
  readonly deliveries: ReadonlyArray<Delivery>;
}

/**
 * What a platform provides for an aggregate type.
 */
export interface AggregateStore {
  /**
   * Handle a command on one instance: single writer per id; dedupe by
   * `commandId`; persist events, state, receipt and deliveries atomically;
   * then deliver at least once, in order.
   */
  readonly send: (id: string, command: Json, meta: Aggregate.SendMeta) => Effect.Effect<SendResult>;
  /**
   * Send a command to one instance when it is due, durably (it survives
   * restarts) and at least once. Replaces a pending one with the same
   * `commandId`. Rejections are impossible: only non-rejecting commands are
   * scheduled. Returns when it is due, in epoch milliseconds on the
   * platform's clock. Fails with `AlreadyExecuted` when the instance already
   * has a receipt for `commandId`, so the command would never run.
   */
  readonly schedule: (
    id: string,
    command: Json,
    meta: Aggregate.SendMeta,
    due: Aggregate.Due,
  ) => Effect.Effect<number, Aggregate.AlreadyExecuted>;
  /**
   * Cancel the pending scheduled command with this `commandId` on one
   * instance, durably, and remember the cancel. Once this succeeds, the
   * command never runs, even one already due. Fails with `AlreadyExecuted`
   * when the instance has a receipt for `commandId`, `AlreadyCancelled` when
   * it was cancelled before (and not scheduled again since), and
   * `NotScheduled` when it was never scheduled.
   */
  readonly unschedule: (
    id: string,
    commandId: string,
  ) => Effect.Effect<
    void,
    Aggregate.AlreadyExecuted | Aggregate.AlreadyCancelled | Aggregate.NotScheduled
  >;
  /** Read the stored state of an instance. */
  readonly state: (id: string) => Effect.Effect<{ readonly state: Json; readonly version: number }>;
  /** Read the committed events of an instance (tests and diagnostics; optional). */
  readonly events?: (id: string) => Effect.Effect<ReadonlyArray<StoredEvent>>;
  /** The stored state and version of an instance, then every new one. */
  readonly changes: (
    id: string,
  ) => Stream.Stream<{ readonly state: Json; readonly version: number }>;
  /** Committed events with `seq > after`, then live ones. */
  readonly tail: (id: string, after: number) => Stream.Stream<StoredEvent>;
  /**
   * Append events without deciding. They reach views as history, and never
   * trigger policies (tests; optional).
   */
  readonly seed?: (id: string, events: ReadonlyArray<Json>) => Effect.Effect<void>;
  /**
   * Accept a WebSocket upgrade (the current request) for a live read of
   * `key`, then push to it on every commit. Optional: without it, live reads
   * are streamed responses over `changes` and `tail`.
   */
  readonly connect?: (key: string, subscription: Subscription) => HttpEffect;
}

/** How much history has reached a consumer: see `View.History`. */
export interface HistoryJson {
  readonly complete: boolean;
}

/**
 * The stored state of one view key.
 */
export interface ViewSnapshot {
  /** The encoded state, or `null` when the key does not exist. */
  readonly state: Json;
  /** Number of applied deliveries. */
  readonly version: number;
  /** Last applied `seq` per source. */
  readonly checkpoints: Readonly<Record<string, number>>;
  /** Number of events the key has emitted. */
  readonly seq: number;
  /** The view's generation the key was built by: an earlier one is stale and starts over. */
  readonly generation?: number;
}

/** The snapshot of a key that has never received a delivery. */
export const emptySnapshot: ViewSnapshot = { state: null, version: 0, checkpoints: {}, seq: 0 };

/**
 * One event a view key emitted, with the key's state after it.
 */
export interface ViewEntry {
  readonly seq: number;
  readonly event: Json;
  readonly envelope: EnvelopeJson;
  readonly state: Json;
}

/**
 * The kernel for one view, handed to a platform.
 */
export interface ViewKit {
  readonly name: string;
  /**
   * Apply deliveries to a key's snapshot: evolve its state and emit events.
   * Drops duplicates. Persist the snapshot and entries together, then send
   * the downstream deliveries.
   */
  readonly apply: (
    key: string,
    snapshot: ViewSnapshot,
    deliveries: ReadonlyArray<Delivery>,
  ) => Effect.Effect<{
    readonly snapshot: ViewSnapshot;
    /** `false` when every delivery was a duplicate. */
    readonly changed: boolean;
    readonly entries: ReadonlyArray<ViewEntry>;
    readonly downstream: ReadonlyArray<Delivery>;
  }>;
  /** Route a downstream delivery to its target's host. */
  readonly deliver: (delivery: Delivery) => Effect.Effect<void>;
  /** The views and projections that consume this view, by `CatchUp.targetId`. */
  readonly targets: ReadonlyArray<string>;
  /** Whether each key of a consumer it feeds hears only from the instance with its own id. */
  readonly consumerSingleSource: (target: string) => boolean;
  /**
   * This view's generation. A stored key built by an earlier one is reset
   * (state, entries, input log and cursors) before it is read or applied to.
   */
  readonly generation: number;
  /** The generation of the view's storage: its generation, unless it is rebuilt in place. */
  readonly classGeneration: number;
  /** The view's id, by `CatchUp.targetId`, in this code. */
  readonly target: string;
  /**
   * Set for a view keyed by the one aggregate it reads (`source`): before a key
   * answers a read, it reads its history from the instance with its own id, so
   * every answer covers the whole history even when no backfill filled it.
   */
  readonly catchUp?: { readonly source: string };
  /** Whether each key hears only from the source instance with its own id (see `Kernel.singleSource`). */
  readonly singleSource: boolean;
  /**
   * Route a source instance's stored rows (as its backfill `log` returns them)
   * to one consumer (by `CatchUp.targetId`), as history: each row's seq and its
   * deliveries. What a key keyed by its source runs on the rows it reads.
   */
  readonly history: (
    target: string,
    source: string,
    id: string,
    rows: ReadonlyArray<unknown>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly deliveries: ReadonlyArray<Delivery> }>
  >;
  /** Route emitted entries to the consumers lagging behind them (see `CatchUp`). */
  readonly replay: (input: ReplayInput<ViewEntry>) => Effect.Effect<ReplayResult>;
  /** Trace an `apply` of these deliveries to `key` (wrap the work that applies and persists them). */
  readonly observe: (
    key: string,
    deliveries: ReadonlyArray<Delivery>,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * What a subscriber of `key` receives, given its snapshot and the entries
   * emitted since (at least those after the subscription's cursor).
   */
  readonly push: (
    key: string,
    subscription: Subscription,
    snapshot: ViewSnapshot,
    entries: ReadonlyArray<ViewEntry>,
  ) => Effect.Effect<Push>;
}

/**
 * What a platform provides for a view.
 */
export interface ViewStore {
  /** Apply deliveries to one key (single writer per key), then forward downstream deliveries. */
  readonly receive: (key: string, deliveries: ReadonlyArray<Delivery>) => Effect.Effect<void>;
  readonly read: (key: string) => Effect.Effect<ViewSnapshot>;
  /** The current snapshot, then every new one. */
  readonly changes: (key: string) => Stream.Stream<ViewSnapshot>;
  /** Every entry of a key. */
  readonly list: (key: string) => Effect.Effect<ReadonlyArray<ViewEntry>>;
  /** Entries with `seq > after`, then live entries. */
  readonly tail: (key: string, after: number) => Stream.Stream<ViewEntry>;
  /**
   * Accept a WebSocket upgrade (the current request) for a live read of
   * `key`, then push to it on every commit. Optional: without it, live reads
   * are streamed responses over `changes` and `tail`.
   */
  readonly connect?: (key: string, subscription: Subscription) => HttpEffect;
}

/**
 * The kernel for one policy, handed to a platform.
 */
export interface PolicyKit {
  readonly name: string;
  /** Run the policy's handler for one delivery. */
  readonly run: (delivery: Delivery) => Effect.Effect<void>;
}

/**
 * What a platform provides for a policy.
 */
export interface PolicyStore {
  /** Run deliveries at least once, in order per key. */
  readonly receive: (delivery: Delivery) => Effect.Effect<void>;
}

/**
 * One delivery a consumer's key accepted, in the key's immutable input log.
 */
export interface Accepted {
  /** The delivery's place in the key's input log, from 1. */
  readonly position: number;
  readonly delivery: Delivery;
  /** Epoch milliseconds it was accepted. */
  readonly at: number;
}

/**
 * How a projection's Layer tunes it (variants, not part of its meaning).
 */
export interface ProjectionOptions {
  /** Hand the handler up to `size` accepted deliveries at once, waiting up to `wait` ms to fill. */
  readonly batch?: { readonly size: number; readonly waitMillis: number };
}

/**
 * The kernel for one projection, handed to a platform.
 */
export interface ProjectionKit {
  readonly name: string;
  readonly options: ProjectionOptions;
  /**
   * This projection's generation. A key's log from an earlier one is reset;
   * deliveries for an earlier one are dropped.
   */
  readonly generation: number;
  /** Whether each key hears only from the source instance with its own id (see `Kernel.singleSource`). */
  readonly singleSource: boolean;
  /**
   * Route a source instance's stored rows (as its backfill `log` returns them)
   * to one consumer (by `CatchUp.targetId`), as history: each row's seq and its
   * deliveries. What a key keyed by its source runs on the rows it reads.
   */
  readonly history: (
    target: string,
    source: string,
    id: string,
    rows: ReadonlyArray<unknown>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly deliveries: ReadonlyArray<Delivery> }>
  >;
  /**
   * Run the handler for a run of one key's input log, in order. Succeeds only
   * when every write the handler made succeeded; the platform then records
   * the run as processed.
   */
  readonly run: (key: string, batch: ReadonlyArray<Accepted>) => Effect.Effect<void>;
}

/**
 * What a platform provides for a projection.
 */
export interface ProjectionStore {
  /**
   * Accept a delivery into its key's input log (dropping one already
   * accepted, by source and `seq`), then process the log in order, in batches.
   */
  readonly receive: (delivery: Delivery) => Effect.Effect<void>;
  /** The last processed `seq` per source stream, for one key. */
  readonly checkpoints: (key: string) => Effect.Effect<Readonly<Record<string, number>>>;
}

/**
 * One entry appended to a stream key.
 */
export interface StreamEntry {
  readonly seq: number;
  readonly event: Json;
  readonly envelope: EnvelopeJson;
}

/**
 * The stored progress of one stream key.
 */
export interface StreamMeta {
  /** Number of entries. */
  readonly seq: number;
  /** The last source `seq` the writer has handled, per source stream. */
  readonly checkpoints: Readonly<Record<string, number>>;
  /** The last write applied: the writer's input-log position and its append index there. */
  readonly origin: readonly [number, number];
}

/** The meta of a stream key nothing has written. */
export const emptyStreamMeta: StreamMeta = { seq: 0, checkpoints: {}, origin: [0, 0] };

/**
 * One append to a stream key, made by its writer while handling an input.
 */
export interface StreamWrite {
  /** Where the write comes from: the writer's input-log position and the append's index there. */
  readonly origin: readonly [number, number];
  /** The source event being handled. */
  readonly source: string;
  readonly sourceSeq: number;
  readonly at: number;
  readonly commandId: string;
  readonly events: ReadonlyArray<Json>;
}

/**
 * The kernel for one stream, handed to a platform.
 */
export interface StreamKit {
  readonly name: string;
  /**
   * What a subscriber of `key` receives, given its meta and the entries
   * appended since (at least those after the subscription's cursor).
   */
  readonly push: (
    key: string,
    subscription: Subscription,
    meta: StreamMeta,
    entries: ReadonlyArray<StreamEntry>,
    latest: StreamEntry | undefined,
  ) => Effect.Effect<Push>;
}

/**
 * What a platform provides for a stream.
 */
export interface StreamStore {
  /**
   * Append a write to one key (single writer per key). A write whose origin is
   * not after the last applied one is a repeat and is dropped.
   */
  readonly append: (key: string, write: StreamWrite) => Effect.Effect<void>;
  /** Record that the writer handled source events without appending. */
  readonly advance: (
    key: string,
    checkpoints: Readonly<Record<string, number>>,
  ) => Effect.Effect<void>;
  readonly read: (key: string) => Effect.Effect<StreamMeta>;
  /** The current meta, then every new one. */
  readonly changes: (key: string) => Stream.Stream<StreamMeta>;
  /** Every entry of a key. */
  readonly list: (key: string) => Effect.Effect<ReadonlyArray<StreamEntry>>;
  /** Entries with `seq > after`, then live entries. */
  readonly tail: (key: string, after: number) => Stream.Stream<StreamEntry>;
  /** Accept a WebSocket upgrade for a live read of `key` (optional, like views). */
  readonly connect?: (key: string, subscription: Subscription) => HttpEffect;
}

/**
 * Where one model is hosted. One factory per concept, each called once per
 * entity while the model's Layer is built. A factory may declare any
 * infrastructure (Durable Objects, buckets, queues) and returns the store the
 * kernel talks to.
 */
export interface ModelHost {
  readonly aggregate: (
    aggregate: Aggregate.Any,
    kit: AggregateKit,
  ) => Effect.Effect<AggregateStore>;
  readonly view: (view: View.Any, kit: ViewKit) => Effect.Effect<ViewStore>;
  readonly policy: (policy: Policy.Any, kit: PolicyKit) => Effect.Effect<PolicyStore>;
  readonly projection: (
    projection: Projection.Any,
    kit: ProjectionKit,
  ) => Effect.Effect<ProjectionStore>;
  readonly stream: (stream: DomainStream.Any, kit: StreamKit) => Effect.Effect<StreamStore>;
  /**
   * Called once every store is built. A platform that keeps events across
   * deploys starts catching up the views and projections in `targets` (every
   * consumer in the model, by `CatchUp.targetId`) that are new to it.
   */
  readonly start?: (
    targets: ReadonlyArray<string>,
    /** What a backfill needs to know of each consumer: the sources it reads, and its keys' shape. */
    planOf: (target: string) => Plan | undefined,
    /**
     * The consumers among `targets` the deploy backfills. The others fill each
     * key themselves, from its own instance (see `ViewKit.catchUp`).
     */
    backfill: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  /**
   * How much of the history recorded before a consumer (by
   * `CatchUp.targetId`) has reached it. A platform without it keeps nothing
   * across deploys, so there is no history to wait for.
   */
  readonly history?: (target: string) => Effect.Effect<HistoryJson>;
}

/** What a platform is told about a model it hosts. */
export interface HostedModel {
  readonly modelName: string;
  /** The same for every Layer of one model, and different for another model with the same name. */
  readonly id: object;
  /** The names of the model's sagas, which run on the workflow engine. */
  readonly sagas: ReadonlyArray<string>;
  /** Whether this model keeps data it shared with other models before Domain version 0: `legacyData` on its `layer`. */
  readonly legacyData: boolean;
}

/**
 * How a Domain is hosted. `model` is called once per model while its Layer is
 * built, and gives that model storage of its own: two models that use the
 * same aggregate, view or stream definition never share its data. Hosting
 * two models with the same name on one platform fails.
 *
 * Swap the platform Layer to move a Domain between infrastructures: in-memory
 * for tests and single processes, Durable Objects on Cloudflare, and so on.
 */
export class Platform extends Context.Service<
  Platform,
  {
    readonly model: (model: HostedModel) => Effect.Effect<ModelHost, never, Scope>;
  }
>()("alchemy/Domain/Platform") {}

/**
 * Track the models a platform hosts: `claim` fails while a different model
 * with the same name is hosted, since both would address the same storage.
 * The same model may be built again while an earlier build is open.
 *
 * @internal
 */
export const hostedModels = ({
  release,
}: {
  /**
   * Free a model's name when its build closes, so it can be built again as
   * a redeploy. A platform whose builds outlive their scope, like a Worker's
   * init, keeps every name for as long as it runs.
   */
  readonly release: boolean;
}) => {
  const hosted = new Map<string, { readonly id: object; builds: number }>();
  return (modelName: string, id: object): Effect.Effect<void, never, Scope> =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        const held = hosted.get(modelName);
        if (held !== undefined && held.id !== id) {
          return Effect.die(
            new DefinitionError({ reason: new ModelHostedTwice({ model: modelName }) }),
          );
        }
        if (held === undefined) hosted.set(modelName, { id, builds: 1 });
        else held.builds++;
        return Effect.void;
      }),
      // Built again after this build closes (a redeploy), the name is free.
      () =>
        Effect.sync(() => {
          if (!release) return;
          const held = hosted.get(modelName);
          if (held !== undefined && --held.builds === 0) hosted.delete(modelName);
        }),
    );
};

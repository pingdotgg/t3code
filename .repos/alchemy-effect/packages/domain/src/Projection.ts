import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Aggregate from "./Aggregate.ts";
import type * as Event from "./Event.ts";
import type * as Key from "./Key.ts";
import type * as DomainStream from "./Stream.ts";
import type * as View from "./View.ts";

/**
 * One input a projection's handler receives: an event, the key it was routed
 * to, and where it came from.
 */
export interface Input<Key extends Key.Any, S, E> {
  /** The key this input was routed to. */
  readonly key: Key.RefOf<Key>;
  /** The route named in `keyOf` that brought it here, if any. */
  readonly route: string | undefined;
  /** The aggregate or view instance the event came from (a view key's value for a Schema-keyed view). */
  readonly source: Key.RefOf<View.SourceKey<S>>;
  readonly event: E;
  readonly envelope: Aggregate.Envelope;
  /** For a view source: the view's state after the event. */
  readonly state: View.SourceState<S>;
  /** The input's place in its key's input log, from 1. */
  readonly position: number;
}

/**
 * A projection's handler: one run of a key's inputs, in order. It runs at
 * least once per input, so make its writes idempotent (an upsert keyed by
 * `envelope.stream` and `envelope.seq` is). Resolve your store, and any stream
 * it writes, while building it, in `toLayer`; the handler itself may only need
 * the runtime it runs in (`RuntimeContext`), as a database binding does.
 */
export type Handler<I> = (batch: ReadonlyArray<I>) => Effect.Effect<void, never, RuntimeContext>;

/**
 * How a projection's Layer tunes it. These are variants: they change how it
 * runs, never what it means.
 */
export interface Options {
  /**
   * Hand the handler up to `size` inputs of one key at once, waiting up to
   * `wait` for a batch to fill. Without it, the handler gets one input at a
   * time, as soon as it arrives.
   */
  readonly batch?: { readonly size: number; readonly wait?: Duration.Input };
  /**
   * Bump it to run the projection again over the whole history, for example
   * after its store was lost or emptied, or once its handler writes a new
   * shape. Clear or migrate your store first if a replayed write would not
   * overwrite the old one. 0 when omitted.
   */
  readonly version?: number;
}

/** A projection's implementation, as its Layer provides it. @internal */
export interface Implementation<I> {
  readonly handle: Handler<I>;
  readonly options: Options;
}

type Sources<From extends ReadonlyArray<View.Source>> = From[number];

/**
 * Structural constraint satisfied by every projection class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "Projection";
  readonly projectionName: string;
  readonly definition: {
    readonly from: ReadonlyArray<View.Source>;
    readonly key: Key.Any;
    readonly keyOf?: { readonly [key: string]: unknown };
    readonly on: ReadonlyArray<Event.Any>;
    readonly writes?: ReadonlyArray<DomainStream.Any>;
  };
  /** The service that reports the projection's progress (`caughtUp`). */
  readonly Progress: Context.Key<unknown, Progress>;
}

/** The input type of a projection class. */
export type InputOf<P extends Any> = Input<
  P["definition"]["key"],
  Sources<P["definition"]["from"]>,
  Aggregate.InstanceOf<P["definition"]["on"][number]>
>;

/** The requirement identifier of a projection class. */
export type Identifier<P extends Any> = P extends Context.Key<infer I, unknown> ? I : never;

/** The requirement identifier of a projection's progress service. */
export type ProgressIdentifier<P extends Any> = P extends Any
  ? P["Progress"] extends Context.Key<infer I, unknown>
    ? I
    : never
  : never;

/**
 * A projection's progress, provided by the hosted model.
 */
export interface Progress {
  /**
   * Whether the history recorded before this projection, or before its
   * current version, has reached it (been accepted into its keys' logs).
   */
  readonly history: Effect.Effect<View.History>;
  /**
   * Wait until the projection has handled every event of a command that it
   * consumes, so a read of your store sees that write.
   */
  readonly caughtUp: (
    receipt: {
      readonly stream: string;
      readonly version: number;
      readonly events: ReadonlyArray<unknown>;
    },
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<void, View.ConsistencyTimeout>;
}

/**
 * Type-level identity of a projection in an Effect's requirements.
 */
export interface ProjectionKey<Name extends string> {
  readonly "~alchemy/Domain/Projection": Name;
}

/** Type-level identity of a projection's progress service. */
export interface ProgressKey<Name extends string> {
  readonly "~alchemy/Domain/Projection/Progress": Name;
}

/**
 * The pure definition of a projection: its invariants.
 */
export interface Definition<
  From extends ReadonlyArray<View.Source>,
  Key extends Key.Any,
  On extends ReadonlyArray<Event.Any>,
  Writes extends ReadonlyArray<DomainStream.Any>,
> {
  /** The aggregates and views whose events it consumes. */
  readonly from: From;
  /**
   * What partitions it: an aggregate, whose refs are its keys, or a string
   * Schema, whose values are. Inputs for one key are handled in order, one
   * key at a time; keys run in parallel.
   */
  readonly key: Key;
  /**
   * Which key each input goes to, by event tag or source name. May be omitted
   * for a source keyed by the same aggregate or Schema. Return a ref (an
   * aggregate key) or a value (a Schema key), or an object of named routes to
   * send one event to several keys.
   */
  readonly keyOf?: {
    readonly [K in View.HandlerKey<From>]?: View.Routed<View.KeyFn<Key, View.InputFor<From, K>>>;
  };
  /** The events it consumes. */
  readonly on: On;
  /** The streams it appends to. Each stream has exactly one writer, keyed like it. */
  readonly writes?: Writes;
}

/**
 * Consumes events into a store you own: a database, a search index, a
 * warehouse, or a `Domain.Stream`. Inputs are routed to keys and handled in
 * order per key, at least once, and batched if its Layer says so. A projection
 * never sends commands: replaying it must never act on the world again.
 *
 * The declaration holds what it means (sources, partitioning, events, the
 * streams it writes). Its Layer holds how it runs: the handler, and options
 * such as batching.
 *
 * ### Writing to a database
 * **Example:** A ledger table, one row per movement
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Effect from "effect/Effect";
 * import { Account } from "./Account.ts";
 * import { MoneyDeposited } from "./DepositMoney.ts";
 * import { LedgerStore } from "./LedgerStore.ts";
 *
 * export class Ledger extends Domain.Projection("Ledger", {
 *   from: [Account],
 *   key: Account,
 *   on: [MoneyDeposited],
 * }) {}
 *
 * export const LedgerLive = Ledger.toLayer(
 *   Effect.gen(function* () {
 *     const store = yield* LedgerStore;
 *     return Effect.fn(function* (batch) {
 *       yield* store.upsert(
 *         batch.map(({ key, event, envelope }) => ({
 *           id: `${envelope.stream}:${envelope.seq}`,
 *           account: key.id,
 *           amount: event.amount,
 *         })),
 *       );
 *     });
 *   }),
 *   { batch: { size: 500, wait: "2 seconds" } },
 * );
 * ```
 *
 * ### Reading your own write
 * **Example:** Wait for the projection before querying the store
 * ```typescript
 * const receipt = yield* accounts.send(accountId, new DepositMoney({ amount: 100 }));
 * yield* Ledger.caughtUp(receipt);
 * ```
 *
 * @primitive
 */
export const make = <
  const Name extends string,
  const From extends ReadonlyArray<View.Source>,
  Key extends Key.Any,
  const On extends ReadonlyArray<Event.Any>,
  const Writes extends ReadonlyArray<DomainStream.Any> = readonly [],
>(
  name: Name,
  definition: Definition<From, Key, On, Writes>,
): ProjectionClass<Name, From, Key, On, Writes> => {
  type I = Input<Key, Sources<From>, Aggregate.InstanceOf<On[number]>>;
  const Tag = Context.Service<ProjectionKey<Name>, Implementation<I>>()(
    `alchemy/Domain/Projection/${name}`,
  );
  const Progress = Context.Service<ProgressKey<Name>, Progress>()(
    `alchemy/Domain/Projection/${name}/Progress`,
  );
  return class extends Tag {
    static readonly kind = "Projection" as const;
    static readonly projectionName: Name = name;
    static readonly definition = definition;
    static readonly Progress = Progress;
    static caughtUp(
      receipt: Parameters<Progress["caughtUp"]>[0],
      options?: Parameters<Progress["caughtUp"]>[1],
    ) {
      return Effect.gen(function* () {
        const progress = yield* Progress;
        return yield* progress.caughtUp(receipt, options);
      });
    }
    static toLayer<E, R>(build: Effect.Effect<Handler<I>, E, R>, options: Options = {}) {
      return Layer.effect(
        Tag,
        Effect.map(build, (handle): Implementation<I> => ({ handle, options })),
      );
    }
  } as unknown as ProjectionClass<Name, From, Key, On, Writes>;
};

/**
 * The class type returned by {@link make}.
 */
export interface ProjectionClass<
  Name extends string,
  From extends ReadonlyArray<View.Source>,
  Key extends Key.Any,
  On extends ReadonlyArray<Event.Any>,
  Writes extends ReadonlyArray<DomainStream.Any>,
> extends Context.ServiceClass<
  ProjectionKey<Name>,
  string,
  Implementation<Input<Key, Sources<From>, Aggregate.InstanceOf<On[number]>>>
> {
  readonly kind: "Projection";
  readonly projectionName: Name;
  readonly definition: Definition<From, Key, On, Writes>;
  readonly Progress: Context.Service<ProgressKey<Name>, Progress>;
  /**
   * Wait until this projection has handled every event of a command that it
   * consumes. Provided by the hosted model.
   */
  caughtUp(
    receipt: Parameters<Progress["caughtUp"]>[0],
    options?: Parameters<Progress["caughtUp"]>[1],
  ): Effect.Effect<void, View.ConsistencyTimeout, ProgressKey<Name>>;
  /**
   * Implement the projection. The construction Effect runs once, resolving
   * your store and the streams it writes; the handler requires nothing.
   * `options` tune how it runs, such as batching.
   */
  toLayer<E, R>(
    build: Effect.Effect<
      Handler<Input<Key, Sources<From>, Aggregate.InstanceOf<On[number]>>>,
      E,
      R
    >,
    options?: Options,
  ): Layer.Layer<ProjectionKey<Name>, E, R>;
}

/** @internal */
export const batchMillis = (options: Options) =>
  options.batch
    ? {
        size: Math.max(1, options.batch.size),
        waitMillis: options.batch.wait
          ? Duration.toMillis(Duration.fromInputUnsafe(options.batch.wait))
          : 0,
      }
    : undefined;

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type * as Aggregate from "./Aggregate.ts";
import type * as Event from "./Event.ts";
import type { Filter } from "./Filter.ts";
import { evolveView, type LocalViewInput } from "./internal.ts";
import type * as Key from "./Key.ts";
import type * as Middleware from "./Middleware.ts";
import type * as Read from "./Read.ts";
import type * as Rejection from "./Rejection.ts";

/**
 * Raised by `waitFor` when the predicate does not hold before the timeout.
 */
export class WaitTimeout extends Data.TaggedError("WaitTimeout")<{
  readonly view: string;
  readonly key: string;
}> {}

/**
 * Raised by a read with `atLeast` when the view has not applied that write
 * before the timeout. A client receives it like a rejection.
 */
export class ConsistencyTimeout extends Schema.TaggedError<ConsistencyTimeout>()(
  "ConsistencyTimeout",
  {
    view: Schema.String,
    key: Schema.String,
    stream: Schema.String,
    version: Schema.Number,
  },
) {}

/** A handler, or one handler per named route. */
type Handlers = {
  readonly [key: string]:
    | ((...args: never[]) => unknown)
    | { readonly [route: string]: ((...args: never[]) => unknown) | undefined }
    | undefined;
};

/**
 * Structural constraint satisfied by every view class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "View";
  readonly viewName: string;
  readonly definition: {
    readonly from: ReadonlyArray<Aggregate.Any | Any>;
    readonly key: Key.Any;
    readonly state?: Schema.Top;
    readonly initial?: unknown;
    readonly keyOf?: Handlers;
    readonly evolve?: Handlers;
    readonly events?: ReadonlyArray<Event.Any>;
    readonly emit?: Handlers;
    readonly computed?: { readonly [name: string]: ((state: never) => unknown) | undefined };
    readonly version?: number;
  } & Read.AnyContract;
  /** Type-level only: the view's state. */
  readonly "~state": unknown;
  /** Type-level only: the events the view emits. */
  readonly "~events": unknown;
}

/** Something a view or policy can consume: an aggregate or a view. */
export type Source = Aggregate.Any | Any;

/** The state type of a view class (`null` for a view without state). */
export type StateOf<V extends Any> = V["~state"];
/** The events a view class emits. */
export type EventOf<V extends Any> = V["~events"];
/** The key aggregate of a view class. */
export type KeyOf<V extends Any> = V["definition"]["key"];

/** The name of a source. */
export type NameOf<S> = S extends Aggregate.Any
  ? S["aggregateName"]
  : S extends Any
    ? S["viewName"]
    : never;
/** The events a source produces. */
export type SourceEvent<S> = S extends Aggregate.Any
  ? Aggregate.EventOf<S>
  : S extends Any
    ? EventOf<S>
    : never;
/** The key that identifies a source's instances: an aggregate, or a view's key. */
export type SourceKey<S> = S extends Aggregate.Any ? S : S extends Any ? KeyOf<S> : never;
/** What a source attaches to each event: a view's state after it, nothing for an aggregate. */
export type SourceState<S> = S extends Any ? StateOf<S> | null : undefined;

/**
 * One input to a view or policy: an event, the source instance it came from,
 * and (for a view source) that view's state after the event.
 */
export type Input<S> = S extends unknown
  ? SourceEvent<S> extends infer E
    ? E extends unknown
      ? {
          readonly name: NameOf<S>;
          readonly event: E;
          readonly source: Key.RefOf<SourceKey<S>>;
          readonly state: SourceState<S>;
        }
      : never
    : never
  : never;

/** Every input a list of sources produces. */
export type Inputs<From extends ReadonlyArray<unknown>> = Input<From[number]>;
type EventTag<From extends ReadonlyArray<unknown>> = Inputs<From>["event"] extends infer E
  ? E extends { readonly _tag: infer T extends string }
    ? T
    : never
  : never;
/**
 * What a handler may be keyed by: an event tag, or a source's name to handle
 * every event from that source.
 */
export type HandlerKey<From extends ReadonlyArray<unknown>> = EventTag<From> | Inputs<From>["name"];
/** The inputs a handler keyed by `K` (an event tag or a source name) receives. */
export type InputFor<From extends ReadonlyArray<unknown>, K> =
  | Extract<Inputs<From>, { readonly event: { readonly _tag: K } }>
  | Extract<Inputs<From>, { readonly name: K }>;

/** The state of a view with state schema `S` (`null` without one). */
export type StateType<S> = S extends Schema.Top ? S["Type"] : null;
/** What a view emits: its declared events, or every event it consumes. */
export type Output<
  From extends ReadonlyArray<unknown>,
  Events extends ReadonlyArray<Event.Any>,
> = Events extends readonly [] ? Inputs<From>["event"] : Aggregate.InstanceOf<Events[number]>;

/**
 * Where an input is delivered and what handlers receive alongside it.
 */
export interface Routing<I> {
  readonly event: I extends { readonly event: infer E } ? E : never;
  /** The source instance the event came from. */
  readonly source: I extends { readonly source: infer R } ? R : never;
  /** For a view source: its state after the event. */
  readonly state: I extends { readonly state: infer S } ? S : never;
  readonly envelope: Aggregate.Envelope;
}

/**
 * The context passed to `evolve` and `emit` handlers.
 */
export interface HandlerContext<Key extends Key.Any, I> {
  /** The view instance being updated: a ref, or the value of a Schema key. */
  readonly key: Key.RefOf<Key>;
  /** The source instance the event came from. */
  readonly source: Routing<I>["source"];
  /** For a view source: its state after the event. */
  readonly state: Routing<I>["state"];
  readonly envelope: Aggregate.Envelope;
  /** The commit time of the originating event. */
  readonly at: DateTime.Utc;
}

/** The context passed to `emit` handlers. */
export interface EmitContext<Key extends Key.Any, I, St> extends HandlerContext<Key, I> {
  /** This view's state before the event. */
  readonly before: St;
  /** This view's state after the event (`null` if it was deleted). */
  readonly after: St | null;
}

/** Picks the key an input goes to, or `undefined` for none. */
export type KeyFn<Key extends Key.Any, I> = (routing: Routing<I>) => Key.RefOf<Key> | undefined;
type EvolveFn<St, Key extends Key.Any, I> = (
  state: St,
  event: Routing<I>["event"],
  context: HandlerContext<Key, I>,
) => St | null;
type EmitFn<St, Key extends Key.Any, I, Out> = (
  event: Routing<I>["event"],
  context: EmitContext<Key, I, St>,
) => Out | ReadonlyArray<Out> | undefined;

/** A handler, or one handler per route named in `keyOf`. */
export type Routed<F> = F | { readonly [route: string]: F };

/**
 * The pure definition of a view.
 */
export interface Definition<
  From extends ReadonlyArray<Source>,
  Key extends Key.Any,
  S extends Schema.Top | undefined,
  Events extends ReadonlyArray<Event.Any>,
  Computed extends Record<string, unknown>,
  Ms extends Middleware.List = readonly [],
  Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
> extends Read.Contract<Key.RefOf<Key>, StateType<S> | null, Ms, Rejects> {
  /** The aggregates and views this view consumes. */
  readonly from: From;
  /**
   * What keys this view's instances: an aggregate, whose refs key them, or a
   * string Schema (such as an org id), whose values key them with no
   * aggregate behind them.
   */
  readonly key: Key;
  /**
   * Which instance each input updates, keyed by event tag or source name. May
   * be omitted for a source keyed by the same aggregate or Schema (the source
   * is the key). Return a ref (an aggregate key) or a value (a Schema key), or
   * an object of named routes to update several instances; each route then
   * gets its own `evolve` and `emit` handler.
   */
  readonly keyOf?: {
    readonly [K in HandlerKey<From>]?: Routed<KeyFn<Key, InputFor<From, K>>>;
  };
  /** Schema of the view's state. Omit it for a view that only emits events. */
  readonly state?: S;
  /** The state every instance starts from. */
  readonly initial?: StateType<S>;
  /**
   * Fold inputs into state, keyed by event tag or source name. Return `null`
   * to delete the instance.
   */
  readonly evolve?: {
    readonly [K in HandlerKey<From>]?: Routed<EvolveFn<StateType<S>, Key, InputFor<From, K>>>;
  };
  /**
   * The events this view emits. Without `events`, a view emits every event it
   * applies, unchanged.
   */
  readonly events?: Events;
  /**
   * Derive the events to emit for an input, keyed by event tag or source name.
   * Runs after `evolve`, with the state before and after. A declared event
   * with no `emit` handler passes through unchanged.
   */
  readonly emit?: {
    readonly [K in HandlerKey<From>]?: Routed<
      EmitFn<StateType<S>, Key, InputFor<From, K>, Aggregate.InstanceOf<Events[number]>>
    >;
  };
  /** Values derived from state when read. */
  readonly computed?: ComputedFns<StateType<S>, Computed>;
  /**
   * Bump it whenever you change what the view computes (`evolve`, `emit`,
   * `keyOf`, `state`, the events or sources it reads): every key is computed
   * again from the history, and so is every view and projection that reads
   * this one. Only ever increase it.
   *
   * A view keyed by the one aggregate it reads is rebuilt in place: the deploy
   * waits for nothing, and each key re-reads its own instance's events the
   * first time it is touched. Any other view is rebuilt from the history
   * before the deploy finishes.
   *
   * @default 0
   */
  readonly version?: number;
}

/** Derived-value functions of a view. */
export type ComputedFns<State, Computed> = {
  readonly [K in keyof Computed]: (state: State) => Computed[K];
};

/**
 * An event a view emitted, with the view's state after it.
 */
export interface Entry<S, E, Id = string> {
  readonly event: E;
  /** The view's state after the event (`null` if deleted, or for a view without state). */
  readonly state: S | null;
  /** `id` is the view key, `stream` is `View/key`, `seq` counts the key's events. */
  readonly envelope: Aggregate.Envelope<Id>;
}

/**
 * A page of entries.
 */
export interface Page<Entry> {
  readonly entries: ReadonlyArray<Entry>;
  /** Pass as `after` to continue; `null` when there are no more entries. */
  readonly cursor: number | null;
}

/**
 * Options for watching a view key.
 */
export interface WatchOptions<S> {
  /** Only emit states matching this filter; emits `none` when filtered out. */
  readonly where?: Filter<S>;
}

/**
 * How much of the history recorded before a view or projection (or before its
 * current version) has reached it. A consumer added to a model that already
 * has events, or rebuilt by bumping its version, receives that history first.
 */
export interface History {
  /** Every event recorded before it has reached it: its answers cover the whole history. */
  readonly complete: boolean;
}

/**
 * The read API of a view, obtained with `yield* MyView`.
 */
export interface Host<S, Key extends Key.Any, E> {
  /**
   * Whether the history recorded before this view, or before its current
   * version, has reached it. Until it has, its answers cover only part of
   * the history: a screen can say so, or hold its reads until it is complete.
   */
  readonly history: Effect.Effect<History>;
  /** Read the current state of a key. `none` if it does not exist. */
  readonly query: (
    key: Key.RefOf<Key>,
    options?: {
      /** Wait until the view has applied this write (a command's `stream` and `version`). */
      readonly atLeast?: { readonly stream: string; readonly version: number };
      readonly timeout?: Duration.Input;
    },
  ) => Effect.Effect<Option.Option<S>, ConsistencyTimeout>;
  /**
   * Read the current state of a key together with its cursor: the `seq` of
   * the last event the key emitted when the state was read. Pass the cursor
   * to `events` as `after` to follow every later change once.
   */
  readonly snapshot: (
    key: Key.RefOf<Key>,
    options?: {
      /** Wait until the view has applied this write (a command's `stream` and `version`). */
      readonly atLeast?: { readonly stream: string; readonly version: number };
      readonly timeout?: Duration.Input;
    },
  ) => Effect.Effect<Read.Snapshot<S | null>, ConsistencyTimeout>;
  /** Wait until a key's state matches a filter. */
  readonly waitFor: (
    key: Key.RefOf<Key>,
    where: Filter<S>,
    options: { readonly timeout: Duration.Input },
  ) => Effect.Effect<S, WaitTimeout>;
  /** The current state, then every change. */
  readonly watch: (
    key: Key.RefOf<Key>,
    options?: WatchOptions<S>,
  ) => Stream.Stream<Option.Option<S>>;
  /**
   * Follow a changing set of keys derived from a parent stream, emitting the
   * parent together with the current state of every key that exists and
   * matches `where`.
   */
  readonly watchEach: <P, Err, R>(
    parent: Stream.Stream<P, Err, R>,
    keysOf: (parent: P) => ReadonlyArray<Key.RefOf<Key>>,
    options?: WatchOptions<S>,
  ) => Stream.Stream<readonly [P, ReadonlyArray<readonly [Key.RefOf<Key>, S]>], Err, R>;
  /**
   * Every event the key emitted, with the state after it: history (from
   * `after`, a cursor or entry `seq`), then live.
   */
  readonly events: (
    key: Key.RefOf<Key>,
    options?: { readonly after?: number; readonly where?: Filter<E> },
  ) => Stream.Stream<Entry<S, E, Key.IdOf<Key>>>;
  /** A page of the key's emitted events, oldest first unless `order` is `"desc"`. */
  readonly list: (
    key: Key.RefOf<Key>,
    options?: {
      readonly where?: Filter<E>;
      readonly order?: "asc" | "desc";
      readonly take?: number;
      readonly after?: number;
    },
  ) => Effect.Effect<Page<Entry<S, E, Key.IdOf<Key>>>>;
}

/**
 * Type-level identity of a view in an Effect's requirements.
 */
export interface ViewKey<Name extends string> {
  readonly "~alchemy/Domain/View": Name;
}

/**
 * A read model: events folded into state per key, kept up to date as new
 * events arrive. A view can emit events of its own, route one event to
 * several keys, and decide who may read it.
 *
 * ### Folding events into state
 * **Example:** An account's balance
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
 * import { Account } from "./Account.ts";
 *
 * export class AccountSummary extends Domain.View("AccountSummary", {
 *   from: [Account],
 *   key: Account,
 *   state: Schema.Struct({ balance: Schema.Int }),
 *   initial: { balance: 0 },
 *   evolve: {
 *     MoneyDeposited: (v, e) => ({ ...v, balance: e.balanceAfter }),
 *     MoneyWithdrawn: (v, e) => ({ ...v, balance: e.balanceAfter }),
 *   },
 * }) {}
 * ```
 *
 * ### Emitting events
 * **Example:** One statement line per movement
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
 * import { Account } from "./Account.ts";
 *
 * export class StatementLine extends Domain.Event("StatementLine", {
 *   kind: Schema.Literals(["deposit", "withdrawal"]),
 *   amount: Schema.Int,
 * }) {}
 *
 * export class Statement extends Domain.View("Statement", {
 *   from: [Account],
 *   key: Account,
 *   events: [StatementLine],
 *   emit: {
 *     MoneyDeposited: (e) => new StatementLine({ kind: "deposit", amount: e.amount }),
 *     MoneyWithdrawn: (e) => new StatementLine({ kind: "withdrawal", amount: e.amount }),
 *   },
 * }) {}
 * ```
 *
 * ### Routing one event to several keys
 * **Example:** A transfer appears on both accounts
 * ```typescript
 * keyOf: {
 *   TransferRequested: {
 *     out: ({ event }) => Account.ref(event.from),
 *     in: ({ event }) => Account.ref(event.to),
 *   },
 * },
 * ```
 *
 * ### Keying by a value
 * **Example:** One schedule per org, with no Org aggregate
 * ```typescript
 * key: OrgId, // a string Schema
 * keyOf: { Tour: ({ event }) => event.orgId },
 * ```
 *
 * ### Validating reads
 * **Example:** Only the owner may read
 * ```typescript
 * middleware: [Session],
 * rejects: [NotOwner],
 * validate: Effect.fn(function* (_request, summary) {
 *   const actor = yield* CurrentActor;
 *   if (summary?.owner && summary.owner !== actor.customerId) return yield* new NotOwner();
 * }),
 * ```
 *
 * @primitive
 */
export const make = <
  const Name extends string,
  const From extends ReadonlyArray<Source>,
  Key extends Key.Any,
  S extends Schema.Top | undefined = undefined,
  const Events extends ReadonlyArray<Event.Any> = readonly [],
  Computed extends Record<string, unknown> = {},
  const Ms extends Middleware.List = readonly [],
  const Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
>(
  name: Name,
  definition: Definition<From, Key, S, Events, Computed, Ms, Rejects>,
): ViewClass<
  Name,
  Definition<From, Key, S, Events, Computed, Ms, Rejects>,
  S,
  StateType<S>,
  Key,
  ComputedFns<StateType<S>, Computed>,
  Output<From, Events>
> => {
  const Tag = Context.Service<ViewKey<Name>, Host<StateType<S>, Key, Output<From, Events>>>()(
    `alchemy/Domain/View/${name}`,
  );
  return class extends Tag {
    static readonly kind = "View" as const;
    static readonly viewName: Name = name;
    static readonly definition: Definition<From, Key, S, Events, Computed, Ms, Rejects> =
      definition;
    /** The view's state schema. */
    static readonly State = definition.state;
    /** Derived values, computed from a state when read. */
    static readonly computed = definition.computed ?? {};
    /** Apply one input to one key's state, as the server's view does. */
    static evolve(state: unknown, input: LocalViewInput) {
      return evolveView({ definition }, state, input);
    }
  } as unknown as ViewClass<
    Name,
    Definition<From, Key, S, Events, Computed, Ms, Rejects>,
    S,
    StateType<S>,
    Key,
    ComputedFns<StateType<S>, Computed>,
    Output<From, Events>
  >;
};

/** One source input, with the source's state optional (aggregates attach none). */
type LocalSourceInput<I> = I extends {
  readonly name: infer N;
  readonly event: infer E;
  readonly source: infer R;
  readonly state: infer S;
}
  ? { readonly name: N; readonly event: E; readonly source: R; readonly state?: S }
  : never;

/** What {@link ViewClass.evolve} applies: a source input, its envelope, and the key. */
export type LocalInput<Def, Key extends Key.Any> = (Def extends {
  readonly from: infer From extends ReadonlyArray<unknown>;
}
  ? LocalSourceInput<Inputs<From>>
  : never) & {
  readonly envelope: Aggregate.Envelope;
  /** The key to update: defaults to what `keyOf` returns, or to the source. */
  readonly key?: Key.RefOf<Key>;
};

/**
 * The class type returned by {@link make}.
 */
export interface ViewClass<
  Name extends string,
  Def,
  S extends Schema.Top | undefined,
  St,
  Key extends Key.Any,
  Computed,
  Out,
> extends Context.ServiceClass<ViewKey<Name>, string, Host<St, Key, Out>> {
  readonly kind: "View";
  readonly viewName: Name;
  readonly definition: Def;
  /** The view's state schema. */
  readonly State: S;
  /** Derived values, computed from a state when read. */
  readonly computed: Computed;
  /**
   * Apply one input (an event of a source) to one key's state, with this
   * view's own `keyOf` and `evolve`: the state the server's view will hold
   * after it. Use it with the events of `Aggregate.predict` to show a view's
   * next state before the server answers. `key` defaults to what `keyOf`
   * returns, or to the source; it is required for a view with routes.
   *
   * **Example:** The next balance of a predicted withdrawal
   * ```typescript
   * const next = outcome.events.reduce(
   *   (state, event, i) =>
   *     AccountSummary.evolve(state, {
   *       name: "Account",
   *       event,
   *       source: Account.ref(id),
   *       envelope: outcome.envelopes[i],
   *     }),
   *   summary,
   * );
   * ```
   */
  evolve(state: St | null, input: LocalInput<Def, Key>): St | null;
  readonly "~state": St;
  readonly "~events": Out;
}

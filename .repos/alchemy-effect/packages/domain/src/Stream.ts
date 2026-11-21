import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as EffectStream from "effect/Stream";
import type * as Aggregate from "./Aggregate.ts";
import type * as Event from "./Event.ts";
import type { Filter } from "./Filter.ts";
import type * as Key from "./Key.ts";
import type * as Middleware from "./Middleware.ts";
import type * as Read from "./Read.ts";
import type * as Rejection from "./Rejection.ts";
import type { ConsistencyTimeout, Page } from "./View.ts";

/**
 * One entry of a stream key: the event appended, and where it sits.
 */
export interface Entry<E, Id = string> {
  readonly event: E;
  /** `id` is the stream key, `stream` is `Stream/key`, `seq` counts the key's entries. */
  readonly envelope: Aggregate.Envelope<Id>;
}

/**
 * Structural constraint satisfied by every stream class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "Stream";
  readonly streamName: string;
  readonly definition: {
    readonly key: Key.Any;
    readonly entries: ReadonlyArray<Event.Any>;
  } & Read.AnyContract;
  /** Type-level only: the entry events. */
  readonly "~event": unknown;
}

/** The entry event type of a stream class. */
export type EventOf<S extends Any> = S["~event"];
/** The key of a stream class: an aggregate, or a string Schema. */
export type KeyOf<S extends Any> = S["definition"]["key"];

/**
 * The pure definition of a stream.
 */
export interface Definition<
  Key extends Key.Any,
  Entries extends ReadonlyArray<Event.Any>,
  Ms extends Middleware.List = readonly [],
  Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
> extends Read.Contract<
  Key.RefOf<Key>,
  Entry<Aggregate.InstanceOf<Entries[number]>, Key.IdOf<Key>> | null,
  Ms,
  Rejects
> {
  /**
   * What keys this stream, one ordered log per key: an aggregate, whose refs
   * are its keys, or a string Schema, whose values are.
   */
  readonly key: Key;
  /** The events the stream's entries may be. */
  readonly entries: Entries;
}

/**
 * What a projection's handler passes to {@link Host.append}: the input it is
 * handling. Every input a projection handler receives qualifies.
 */
export interface Origin<Key extends Key.Any> {
  readonly key: Key.RefOf<Key>;
}

/**
 * The API of a stream, obtained with `yield* MyStream`.
 */
export interface Host<Key extends Key.Any, E> {
  /** The latest entry of a key, or `none` if nothing was appended. */
  readonly peek: (
    key: Key.RefOf<Key>,
    options?: {
      /** Wait until the stream's writer has handled this write (a command's `stream` and `version`). */
      readonly atLeast?: { readonly stream: string; readonly version: number };
      readonly timeout?: Duration.Input;
    },
  ) => Effect.Effect<Option.Option<Entry<E, Key.IdOf<Key>>>, ConsistencyTimeout>;
  /** The latest entry, then each new one. */
  readonly watch: (
    key: Key.RefOf<Key>,
  ) => EffectStream.Stream<Option.Option<Entry<E, Key.IdOf<Key>>>>;
  /** Every entry from `after` (an entry `seq`), then live ones. */
  readonly events: (
    key: Key.RefOf<Key>,
    options?: { readonly after?: number; readonly where?: Filter<E> },
  ) => EffectStream.Stream<Entry<E, Key.IdOf<Key>>>;
  /** A page of a key's entries, oldest first unless `order` is `"desc"`. */
  readonly list: (
    key: Key.RefOf<Key>,
    options?: {
      readonly where?: Filter<E>;
      readonly order?: "asc" | "desc";
      readonly take?: number;
      readonly after?: number;
    },
  ) => Effect.Effect<Page<Entry<E, Key.IdOf<Key>>>>;
  /**
   * Append entries for the input a projection is handling, to that input's
   * key. Only a projection that lists this stream in `writes` may append, and
   * a replayed or redelivered input appends nothing twice.
   */
  readonly append: (origin: Origin<Key>, ...events: ReadonlyArray<E>) => Effect.Effect<void>;
}

/**
 * Type-level identity of a stream in an Effect's requirements.
 */
export interface StreamKey<Name extends string> {
  readonly "~alchemy/Domain/Stream": Name;
}

/**
 * A keyed, append-only log: one ordered list of entries per key, kept and
 * replayable. A projection writes it; clients read it through an Api with the
 * same middleware and `validate` as a view. Its latest entry is its current
 * value, so a stream of snapshots serves both "what is it now?" (`peek`) and
 * "tell me every change" (`watch`, `events`).
 *
 * ### Declaring a stream
 * **Example:** An account card, one entry per change
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
 * import { Account } from "./Account.ts";
 *
 * export class CardChanged extends Domain.Event("CardChanged", {
 *   owner: Schema.String,
 *   balance: Schema.Int,
 * }) {}
 *
 * export class AccountCard extends Domain.Stream("AccountCard", {
 *   key: Account,
 *   entries: [CardChanged],
 * }) {}
 * ```
 *
 * ### Writing it from a projection
 * A projection lists the streams it writes, then appends for the input it is
 * handling.
 *
 * **Example:** Append a card for every summary change
 * ```typescript
 * export class AccountCards extends Domain.Projection("AccountCards", {
 *   from: [AccountSummary],
 *   key: Account,
 *   on: [MoneyDeposited],
 *   writes: [AccountCard],
 * }) {}
 *
 * export const AccountCardsLive = AccountCards.toLayer(
 *   Effect.gen(function* () {
 *     const cards = yield* AccountCard;
 *     return Effect.fn(function* (batch) {
 *       for (const input of batch) {
 *         yield* cards.append(input, new CardChanged({ owner: input.state.owner, balance: input.state.balance }));
 *       }
 *     });
 *   }),
 * );
 * ```
 *
 * ### Reading it
 * **Example:** Through an Api
 * ```typescript
 * const latest = yield* bank.AccountCard.peek(accountId);
 * yield* bank.AccountCard.watch(accountId).pipe(
 *   Stream.runForEach(({ state: card }) => Effect.log(card)),
 * );
 * ```
 *
 * @primitive
 */
export const make = <
  const Name extends string,
  Key extends Key.Any,
  const Entries extends ReadonlyArray<Event.Any>,
  const Ms extends Middleware.List = readonly [],
  const Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
>(
  name: Name,
  definition: Definition<Key, Entries, Ms, Rejects>,
): StreamClass<
  Name,
  Definition<Key, Entries, Ms, Rejects>,
  Key,
  Aggregate.InstanceOf<Entries[number]>
> => {
  const Tag = Context.Service<StreamKey<Name>, Host<Key, Aggregate.InstanceOf<Entries[number]>>>()(
    `alchemy/Domain/Stream/${name}`,
  );
  return class extends Tag {
    static readonly kind = "Stream" as const;
    static readonly streamName: Name = name;
    static readonly definition = definition;
  } as unknown as StreamClass<
    Name,
    Definition<Key, Entries, Ms, Rejects>,
    Key,
    Aggregate.InstanceOf<Entries[number]>
  >;
};

/**
 * The class type returned by {@link make}.
 */
export interface StreamClass<
  Name extends string,
  Def,
  Key extends Key.Any,
  E,
> extends Context.ServiceClass<StreamKey<Name>, string, Host<Key, E>> {
  readonly kind: "Stream";
  readonly streamName: Name;
  readonly definition: Def;
  readonly "~event": E;
}

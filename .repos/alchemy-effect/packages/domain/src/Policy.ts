import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schedule from "effect/Schedule";
import type * as Aggregate from "./Aggregate.ts";
import type * as Event from "./Event.ts";
import type * as Key from "./Key.ts";
import type * as View from "./View.ts";

/** One source, or several. */
export type From = View.Source | ReadonlyArray<View.Source>;
/** The sources of a `from`. */
export type SourcesOf<F> = F extends ReadonlyArray<infer S> ? S : F;

/**
 * What a policy receives for each event it subscribes to.
 */
export interface Trigger<F, E, Key extends Key.Any = View.SourceKey<SourcesOf<F>>> {
  /** The key the event was routed to: the source instance, unless the policy declares `key`. */
  readonly key: Key.RefOf<Key>;
  /** The route named in `keyOf` that brought it here, if any. */
  readonly route: string | undefined;
  /** The aggregate or view instance the event came from (a view key's value for a Schema-keyed view). */
  readonly source: Key.RefOf<View.SourceKey<SourcesOf<F>>>;
  /** The event. */
  readonly event: E;
  /** The event's envelope. */
  readonly envelope: Aggregate.Envelope<Key.IdOf<View.SourceKey<SourcesOf<F>>>>;
  /** For a view source: the view's state after the event. */
  readonly state: View.SourceState<SourcesOf<F>>;
}

/**
 * How a policy's Layer tunes it. These are variants: they change how it runs,
 * never what it means.
 */
export interface Options {
  /** Retry a failed run on this schedule before leaving it to the platform's redelivery. */
  readonly retry?: Schedule.Schedule<unknown, unknown>;
}

/**
 * A policy's handler. It runs after the triggering event commits, at least
 * once, in order per source instance. Every failure must be handled: send a
 * command or ignore it. It requires nothing: resolve aggregate clients, Ports
 * and views while building it, in `toLayer`.
 */
export type Handler<T> = (trigger: T) => Effect.Effect<void>;

/**
 * Structural constraint satisfied by every policy class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "Policy";
  readonly policyName: string;
  readonly definition: {
    readonly from: From;
    readonly key?: Key.Any;
    readonly keyOf?: { readonly [key: string]: unknown };
    readonly on: ReadonlyArray<Event.Any>;
  };
}

/** The declared `key` (an optional field), or the source's key when there is none. */
type KeyOfDefinition<D> = D extends { readonly key?: infer K }
  ? Exclude<K, undefined> extends infer Declared extends Key.Any
    ? [Declared] extends [never]
      ? SourceKeyOfDefinition<D>
      : Declared
    : SourceKeyOfDefinition<D>
  : SourceKeyOfDefinition<D>;
type SourceKeyOfDefinition<D> = D extends { readonly from: infer F }
  ? View.SourceKey<SourcesOf<F>>
  : never;

/** The trigger type of a policy class. */
export type TriggerOf<P extends Any> = Trigger<
  P["definition"]["from"],
  Aggregate.InstanceOf<P["definition"]["on"][number]>,
  KeyOfDefinition<P["definition"]>
>;

type AsList<F> = F extends ReadonlyArray<View.Source> ? F : readonly [F];

/**
 * The pure definition of a policy: its invariants.
 */
export interface Definition<
  F extends From,
  On extends ReadonlyArray<Event.Any>,
  Key extends Key.Any | undefined,
> {
  /** The aggregate or view, or several, whose events it reacts to. */
  readonly from: F;
  /**
   * What partitions it: an aggregate, whose refs are its keys, or a string
   * Schema, whose values are. Triggers for one key run in order, one at a
   * time. Defaults to the source instance.
   */
  readonly key?: Key;
  /** Which key each trigger goes to, by event tag or source name (like a view's `keyOf`). */
  readonly keyOf?: Key extends Key.Any
    ? {
        readonly [K in View.HandlerKey<AsList<F>>]?: View.Routed<
          View.KeyFn<Key, View.InputFor<AsList<F>, K>>
        >;
      }
    : never;
  /** The events it reacts to. */
  readonly on: On;
}

/** The requirement identifier of a policy class. */
export type Identifier<P extends Any> = P extends Context.Key<infer I, unknown> ? I : never;

/**
 * Type-level identity of a policy in an Effect's requirements.
 */
export interface PolicyKey<Name extends string> {
  readonly "~alchemy/Domain/Policy": Name;
}

/**
 * "Whenever this happens, do that": one of the business's standing rules. On
 * an event from an aggregate or a view, it decides what to do next and acts by
 * sending commands and calling external systems. Policies run shortly after the
 * event, never in the same step, so use them only for eventually consistent
 * work. Delivery is at least once; the commands a policy sends get ids
 * derived from the event, so a second run sends the same commands.
 *
 * ### Reacting to an aggregate
 * **Example:** Open an account for every new customer
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Effect from "effect/Effect";
 * import { Account, AccountId, OpenAccount } from "./Account.ts";
 * import { Customer, CustomerRegistered } from "./Customer.ts";
 *
 * export class MainAccountProvisioning extends Domain.Policy("MainAccountProvisioning", {
 *   from: Customer,
 *   on: [CustomerRegistered],
 * }) {}
 *
 * export const MainAccountProvisioningLive = MainAccountProvisioning.toLayer(
 *   Effect.gen(function* () {
 *     const accounts = yield* Account;
 *     return Effect.fn(function* ({ source }) {
 *       yield* accounts
 *         .send(AccountId.make(`${source.id}-main`), new OpenAccount({ owner: source.id }))
 *         .pipe(Effect.catchTag("AlreadyOpen", () => Effect.void));
 *     });
 *   }),
 * );
 * ```
 *
 * ### Calling an external system
 * **Example:** Score risky withdrawals
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Effect from "effect/Effect";
 * import { Account, MoneyWithdrawn } from "./Account.ts";
 * import { FraudCheck } from "./FraudCheck.ts";
 *
 * export class FraudReview extends Domain.Policy("FraudReview", {
 *   from: Account,
 *   on: [MoneyWithdrawn],
 * }) {}
 *
 * export const FraudReviewLive = FraudReview.toLayer(
 *   Effect.gen(function* () {
 *     const fraud = yield* FraudCheck;
 *     return Effect.fn(function* ({ source, event }) {
 *       const { risk } = yield* fraud.score({ accountId: source.id, amount: event.amount });
 *       yield* Effect.log(`risk ${risk} for ${source.id}`);
 *     });
 *   }),
 * );
 * ```
 *
 * @primitive
 */
export const make = <
  const Name extends string,
  const F extends From,
  const On extends ReadonlyArray<Event.Any>,
  Key extends Key.Any | undefined = undefined,
>(
  name: Name,
  definition: Definition<F, On, Key>,
): PolicyClass<Name, F, On, Key extends Key.Any ? Key : View.SourceKey<SourcesOf<F>>> => {
  const Tag = Context.Service<PolicyKey<Name>, Handler<unknown>>()(`alchemy/Domain/Policy/${name}`);
  return class extends Tag {
    static readonly kind = "Policy" as const;
    static readonly policyName: Name = name;
    static readonly definition = definition;
    static toLayer<Self extends Any, E, R>(
      this: Self,
      build: Effect.Effect<Handler<TriggerOf<Self>>, E, R>,
      options: Options = {},
    ): Layer.Layer<Identifier<Self>, E, R> {
      const retry = options.retry;
      return Layer.effect(
        this as unknown as Context.Key<Identifier<Self>, Handler<TriggerOf<Self>>>,
        retry
          ? Effect.map(
              build,
              (handle): Handler<TriggerOf<Self>> =>
                (trigger) =>
                  handle(trigger).pipe(
                    Effect.catchDefect((defect) => Effect.fail(defect)),
                    Effect.retry(retry),
                    Effect.orDie,
                  ),
            )
          : build,
      );
    }
  } as unknown as PolicyClass<
    Name,
    F,
    On,
    Key extends Key.Any ? Key : View.SourceKey<SourcesOf<F>>
  >;
};

/**
 * The class type returned by {@link make}.
 */
export interface PolicyClass<
  Name extends string,
  F extends From,
  On extends ReadonlyArray<Event.Any>,
  Key extends Key.Any,
> extends Context.ServiceClass<
  PolicyKey<Name>,
  string,
  Handler<Trigger<F, Aggregate.InstanceOf<On[number]>, Key>>
> {
  readonly kind: "Policy";
  readonly policyName: Name;
  readonly definition: {
    readonly from: F;
    readonly key?: Key;
    readonly keyOf?: { readonly [key: string]: unknown };
    readonly on: On;
  };
  /**
   * Implement the policy. The construction Effect runs once, resolving every
   * service the handler uses (aggregate clients, views, Ports); the handler
   * itself requires nothing. `options` tune how it runs, such as retries.
   */
  toLayer<Self extends Any, E, R>(
    this: Self,
    build: Effect.Effect<Handler<TriggerOf<Self>>, E, R>,
    options?: Options,
  ): Layer.Layer<Identifier<Self>, E, R>;
}

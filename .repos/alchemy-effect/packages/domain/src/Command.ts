import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import type * as Event from "./Event.ts";
import type { Data, Fields } from "./Event.ts";
import * as Middleware from "./Middleware.ts";
import type * as Rejection from "./Rejection.ts";
import type * as Telemetry from "./Telemetry.ts";

/**
 * Instance type of a Command class: its `_tag` plus its input.
 */
export type Instance<Tag extends string, F extends Fields> = { readonly _tag: Tag } & Data<F>;

/** The schema of the aggregate id a command addresses. */
export type TargetSchema = Schema.Top & { readonly Type: string; readonly Encoded: string };

/**
 * Structural constraint satisfied by every class produced by {@link make}.
 */
export interface Any extends Schema.Top {
  readonly kind: "Command";
  readonly tag: string;
  readonly target: TargetSchema;
  readonly events: ReadonlyArray<Event.Any>;
  readonly rejects: ReadonlyArray<Rejection.Any>;
  readonly reply: Schema.Top | undefined;
  readonly middleware: Middleware.List;
  readonly rpc: Rpc.Any;
  new (...args: any[]): { readonly _tag: string };
}

/**
 * The services a command's `decide` may use: whatever its middleware
 * provides. Senders without that middleware (policies, stories) provide them.
 */
export type ContextOf<C extends Any> = Middleware.Provides<C["middleware"]>;

/**
 * The reply schema declared by a command, as a `Schema.Struct`.
 */
export type ReplySchema<Reply extends Fields | undefined> = Reply extends Fields
  ? Schema.Struct<Reply>
  : undefined;

/** What a client sends: the target, an optional idempotency key, and the input. */
export type PayloadFields<Target extends TargetSchema, F extends Fields> = {
  readonly target: Target;
  readonly commandId: Schema.optional<typeof Schema.String>;
  readonly input: Schema.Struct<F>;
};

/** What a client receives: the reply and the position of the committed events. */
export type SuccessFields<Reply extends Schema.Top | undefined> = {
  readonly reply: Reply extends Schema.Top ? Reply : typeof Schema.Void;
  readonly stream: typeof Schema.String;
  readonly version: typeof Schema.Number;
};

/** The Effect RPC definition of a command. */
export type CommandRpc<
  Tag extends string,
  Target extends TargetSchema,
  F extends Fields,
  Rejects extends ReadonlyArray<Rejection.Any>,
  Reply extends Schema.Top | undefined,
> = Rpc.Rpc<
  Tag,
  Schema.Struct<PayloadFields<Target, F>>,
  Schema.Struct<SuccessFields<Reply>>,
  Rejects extends readonly [] ? typeof Schema.Never : Schema.Union<Rejects>
>;

/**
 * The class type returned by {@link make}.
 */
export interface CommandClass<
  Tag extends string,
  Target extends TargetSchema,
  F extends Fields,
  Events extends ReadonlyArray<Event.Any>,
  Rejects extends ReadonlyArray<Rejection.Any>,
  Reply extends Schema.Top | undefined,
  Ms extends Middleware.List,
  R extends Rpc.Any,
> extends Schema.Class<Instance<Tag, F>, Schema.TaggedStruct<Tag, F>, {}> {
  readonly kind: "Command";
  readonly tag: Tag;
  readonly target: Target;
  readonly events: Events;
  readonly rejects: Rejects;
  readonly reply: Reply;
  /** The middleware that guards the command when an Api exposes it, in order. */
  readonly middleware: Ms;
  /** The command as an Effect RPC, for exposing it in an Api. */
  readonly rpc: R;
  /** Span attributes the command adds for its input, if it declares any. */
  readonly attributes: Telemetry.Attributes<Instance<Tag, F>> | undefined;
}

interface Options {
  readonly target: TargetSchema;
  readonly input?: Fields;
  readonly middleware?: Middleware.List;
  readonly events?: ReadonlyArray<Event.Any>;
  readonly rejects?: ReadonlyArray<Rejection.Any>;
  readonly reply?: Fields;
  readonly attributes?: Telemetry.Attributes<any>;
}

const build = (tag: string, options: Options, rpc: Rpc.Any): unknown => {
  // The base type is conditional on `Self`, so it is not a constructor until `make` returns.
  const Base = Schema.TaggedClass<{ readonly _tag: string }>(tag)(
    tag,
    options.input ?? {},
  ) as unknown as new (input: object) => object;
  return class extends Base {
    static readonly kind = "Command" as const;
    static readonly tag = tag;
    static readonly target = options.target;
    static readonly events = options.events ?? [];
    static readonly rejects = options.rejects ?? [];
    static readonly reply = options.reply ? Schema.Struct(options.reply) : undefined;
    static readonly middleware = options.middleware ?? [];
    static readonly rpc = rpc;
    static readonly attributes = options.attributes;
  };
};

/**
 * A request to change one aggregate instance. It names the instance it
 * targets, its input, the events it may record, the rejections it may return,
 * the middleware that guards it, and the reply its caller receives.
 *
 * ### Declaring a command
 * **Example:** A command with its event and rejection
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
 *
 * export const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
 *
 * export class MoneyWithdrawn extends Domain.Event("MoneyWithdrawn", {
 *   amount: Schema.Int,
 *   balanceAfter: Schema.Int,
 * }) {}
 *
 * export class InsufficientFunds extends Domain.Rejection("InsufficientFunds", {
 *   balance: Schema.Int,
 *   requested: Schema.Int,
 * }) {}
 *
 * export class WithdrawMoney extends Domain.Command("WithdrawMoney", {
 *   target: AccountId,
 *   input: { amount: Schema.Int },
 *   events: [MoneyWithdrawn],
 *   rejects: [InsufficientFunds],
 *   reply: { balance: Schema.Int },
 * }) {}
 * ```
 *
 * ### Guarding it with middleware
 * `middleware` runs in order before the command reaches its aggregate. What
 * it provides, such as the current actor, is what `decide` may read.
 *
 * **Example:** Requiring a session and a second factor
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
 * import { AccountId, MoneyWithdrawn } from "./Account.ts";
 * import { MfaChallenge } from "./MfaChallenge.ts";
 * import { Session } from "./Session.ts";
 *
 * export class WithdrawMoney extends Domain.Command("WithdrawMoney", {
 *   target: AccountId,
 *   middleware: [Session, MfaChallenge],
 *   input: { amount: Schema.Int },
 *   events: [MoneyWithdrawn],
 *   reply: { balance: Schema.Int },
 * }) {}
 * ```
 *
 * ### Sending it once
 * Pass a `commandId`, and a resend with the same id returns the first
 * receipt instead of applying the command again.
 *
 * **Example:** An idempotent send through an Api
 * ```typescript
 * const receipt = yield* bank.WithdrawMoney(accountId, { amount: 2_000 }, { commandId: requestId });
 * ```
 *
 * @primitive
 */
export const make = <
  const Tag extends string,
  Target extends TargetSchema,
  const F extends Fields = {},
  const Ms extends Middleware.List = readonly [],
  const Events extends ReadonlyArray<Event.Any> = readonly [],
  const Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
  const Reply extends Fields | undefined = undefined,
>(
  tag: Tag,
  options: {
    /** The id schema of the aggregate this command addresses. */
    readonly target: Target;
    /** The command's fields. */
    readonly input?: F;
    /**
     * Middleware that guards the command when an Api exposes it, in order.
     * What it provides is what `decide` may read.
     */
    readonly middleware?: Ms;
    /** The events the command may record. */
    readonly events?: Events;
    /** The rejections the command's handler may return. */
    readonly rejects?: Rejects;
    /** The reply computed after the events are committed. */
    readonly reply?: Reply;
    /**
     * Span attributes to record for the command's input, on every span it
     * passes through. Nothing from the input is recorded unless you return it
     * here, and a `Redacted` value is recorded as `<redacted>`.
     */
    readonly attributes?: Telemetry.Attributes<Instance<Tag, F>>;
  },
): CommandClass<
  Tag,
  Target,
  F,
  Events,
  Rejects,
  ReplySchema<Reply>,
  Ms,
  Middleware.Apply<CommandRpc<Tag, Target, F, Rejects, ReplySchema<Reply>>, Ms>
> => {
  const rejects = options.rejects ?? [];
  const rpc = Rpc.make(tag, {
    payload: {
      target: options.target,
      commandId: Schema.optional(Schema.String),
      input: Schema.Struct(options.input ?? {}),
    },
    success: Schema.Struct({
      reply: options.reply ? Schema.Struct(options.reply) : Schema.Void,
      stream: Schema.String,
      version: Schema.Number,
    }),
    error: rejects.length === 0 ? Schema.Never : Schema.Union(rejects),
  });
  return build(tag, options, Middleware.apply(rpc, options.middleware ?? [])) as CommandClass<
    Tag,
    Target,
    F,
    Events,
    Rejects,
    ReplySchema<Reply>,
    Ms,
    Middleware.Apply<CommandRpc<Tag, Target, F, Rejects, ReplySchema<Reply>>, Ms>
  >;
};

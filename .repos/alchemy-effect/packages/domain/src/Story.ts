import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Formatter from "effect/Formatter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { DurableDeferred, WorkflowEngine } from "effect/workflow";
import * as Aggregate from "./Aggregate.ts";
import type * as Command from "./Command.ts";
import * as ExternalSystem from "./ExternalSystem.ts";
import * as InMemory from "./InMemory.ts";
import type * as Key from "./Key.ts";
import * as Model from "./Model.ts";
import type * as Saga from "./Saga.ts";
import type * as DomainStream from "./Stream.ts";
import type * as View from "./View.ts";

/** How far a story got with one step. */
export interface StepReport {
  /** The step's number, from 1. */
  readonly step: number;
  /** The step's kind: `Given`, `When`, `Then`, ... */
  readonly kind: Step["_tag"];
  readonly status: "passed" | "failed" | "not-run";
  /** A one-line summary of the step. Redacted values print as `<redacted>`. */
  readonly summary: string;
}

/**
 * A failed story expectation. `message` starts with `reason`, then lists every
 * step (✓ passed, ✗ failed, blank: not run) and the events each touched
 * aggregate committed so far.
 */
export class StoryFailure extends Data.TaggedError("StoryFailure")<{
  /** The step that failed (the last step for a failure at the end of the story). */
  readonly step: number;
  readonly message: string;
  /** Why the story failed, without the step list. */
  readonly reason: string;
  readonly steps: ReadonlyArray<StepReport>;
  /** The tags of the events committed so far, per touched aggregate (`Aggregate/id`). */
  readonly events: Readonly<Record<string, ReadonlyArray<string>>>;
}> {}

/** A failure inside the runner, before it is turned into a {@link StoryFailure}. */
class StepFailed extends Data.TaggedError("StepFailed")<{
  readonly step: number;
  readonly message: string;
  /** The failure is about the whole story, not one step. */
  readonly atEnd?: boolean;
  /** What the step expected and what it got, as short summaries. */
  readonly expected?: string;
  readonly actual?: string;
  /** What the expected / actual pair is about, e.g. `Counter/c-1`. */
  readonly label?: string;
  /** A line to print under the failed step. */
  readonly detail?: string;
}> {}

/** Marker for "the view key does not exist". */
const none: unique symbol = Symbol.for("alchemy/Domain/Story.none") as any;

/**
 * One step of a story. Build steps with the step constructors in this module.
 */
export type Step =
  | {
      readonly _tag: "Given";
      readonly ref: Aggregate.Ref;
      readonly events: ReadonlyArray<{ readonly _tag: string }>;
    }
  | {
      readonly _tag: "When";
      readonly ref: Aggregate.Ref;
      readonly command: { readonly _tag: string };
      readonly commandId?: string;
    }
  | {
      readonly _tag: "Then";
      readonly ref: Aggregate.Ref;
      readonly events: ReadonlyArray<{ readonly _tag: string }>;
    }
  | { readonly _tag: "Rejected"; readonly rejection: { readonly _tag: string } }
  | { readonly _tag: "Replied"; readonly reply: unknown }
  | { readonly _tag: "State"; readonly ref: Aggregate.Ref; readonly expected: unknown }
  | {
      readonly _tag: "View";
      readonly view: View.Any;
      /** A ref, or the value of a Schema key. */
      readonly key: Key.RefOf<Key.Any>;
      readonly expected: unknown;
    }
  | {
      readonly _tag: "Emitted";
      readonly view: View.Any;
      /** A ref, or the value of a Schema key. */
      readonly key: Key.RefOf<Key.Any>;
      readonly expected: unknown;
    }
  | {
      readonly _tag: "Streamed";
      readonly stream: DomainStream.Any;
      /** A ref, or the value of a Schema key. */
      readonly key: Key.RefOf<Key.Any>;
      readonly events: ReadonlyArray<{ readonly _tag: string }>;
    }
  | {
      readonly _tag: "Call";
      readonly tag: string | undefined;
      readonly op: ExternalSystem.Op;
      readonly args: unknown;
    }
  | {
      readonly _tag: "Answer";
      readonly tag: string | undefined;
      readonly op: ExternalSystem.Op;
      readonly exit: Exit.Exit<unknown, unknown>;
    }
  | {
      readonly _tag: "Returned";
      readonly tag: string | undefined;
      readonly op: ExternalSystem.Op;
      readonly expected:
        | { readonly _tag: "Success"; readonly value: unknown }
        | { readonly _tag: "Failure"; readonly error: unknown }
        | { readonly _tag: "Died" };
    }
  | { readonly _tag: "Clock"; readonly at: string | number | DateTime.DateTime }
  | { readonly _tag: "Advance"; readonly by: Duration.Input }
  | {
      readonly _tag: "Signal";
      readonly saga: Saga.Any;
      readonly key: unknown;
      readonly deferred: DurableDeferred.Any;
      readonly value: unknown;
    }
  | {
      readonly _tag: "Saga";
      readonly saga: Saga.Any;
      readonly key: unknown;
      readonly expected: Saga.Status<unknown, unknown> | { readonly _tag: "Died" };
    }
  | {
      readonly _tag: "Provide";
      readonly service: Context.Key<unknown, unknown>;
      readonly value: unknown;
    };

/** The step with this `_tag`. */
export type StepOf<Tag extends Step["_tag"]> = Extract<Step, { readonly _tag: Tag }>;

/**
 * A `when` step. Its type carries the command's class, so the steps after it
 * are checked against what the command declares.
 */
export interface WhenStep<C = unknown> extends StepOf<"When"> {
  readonly "~command"?: C;
}

/** A `rejected` step; its type carries the rejection. */
export interface RejectedStep<R = unknown> extends StepOf<"Rejected"> {
  readonly "~rejection"?: R;
}

/** A `replied` step; its type carries the reply. */
export interface RepliedStep<A = unknown> extends StepOf<"Replied"> {
  readonly "~reply"?: A;
}

/** A `provide` step; its type carries the service it provides. */
export interface ProvideStep<I = unknown> extends StepOf<"Provide"> {
  readonly "~provides"?: I;
}

type CommandClassOf<A extends Aggregate.Any, Cmd> = Extract<
  A["definition"]["commands"][number],
  { readonly tag: Cmd extends { readonly _tag: infer T } ? T : never }
>;
type RejectionOf<C extends Command.Any> = Aggregate.InstanceOf<C["rejects"][number]>;
type ReplyOf<C extends Command.Any> = C["reply"] extends Schema.Top ? C["reply"]["Type"] : void;
type NameOf<X, Key extends string, Fallback extends string> = X extends {
  readonly [K in Key]: infer N extends string;
}
  ? N
  : Fallback;

/** What a `when` step must be: an error message when a service it needs is not provided yet. */
type CheckWhen<H, K extends Command.Any, P> = [Exclude<Command.ContextOf<K>, P>] extends [never]
  ? H
  : `${K["tag"]} needs Story.provide(${NameOf<Exclude<Command.ContextOf<K>, P>, "key", "its service">}) before it`;

/** What a `rejected` step must be: an error message when the last command does not declare it. */
type CheckRejected<H, R, C> = C extends Command.Any
  ? [R] extends [RejectionOf<C>]
    ? H
    : `${C["tag"]} does not reject with ${NameOf<R, "_tag", "this rejection">}`
  : H;

/** What a `replied` step must be: the last command's reply, or an error message when it declares none. */
type CheckReplied<H, A, C> = C extends Command.Any
  ? [A] extends [ReplyOf<C>]
    ? H
    : C["reply"] extends Schema.Top
      ? RepliedStep<ReplyOf<C>>
      : `${C["tag"]} declares no reply`
  : H;

/**
 * The steps of a story, checked in order: a `rejected` step takes only a
 * rejection the last `when` command declares, a `replied` step only its reply
 * type, and a `when` needs a `provide` step before it for every service its
 * command's middleware provides. A failing step is replaced by a message
 * saying what is wrong, so the type error names it. A step typed as plain
 * {@link Step} turns the checks off until the next `when`, since it may be any
 * step.
 */
export type Checked<
  S extends ReadonlyArray<Step>,
  C = unknown,
  P = never,
  Out extends ReadonlyArray<unknown> = [],
> = S extends readonly [infer H extends Step, ...infer T extends ReadonlyArray<Step>]
  ? [H] extends [WhenStep<infer K>]
    ? K extends Command.Any
      ? Checked<T, K, P, [...Out, CheckWhen<H, K, P>]>
      : Checked<T, unknown, P, [...Out, H]>
    : [H] extends [ProvideStep<infer I>]
      ? Checked<T, C, P | I, [...Out, H]>
      : [H] extends [RejectedStep<infer R>]
        ? Checked<T, C, P, [...Out, CheckRejected<H, R, C>]>
        : [H] extends [RepliedStep<infer A>]
          ? Checked<T, C, P, [...Out, CheckReplied<H, A, C>]>
          : [Step] extends [H]
            ? Checked<T, unknown, any, [...Out, H]>
            : Checked<T, C, P, [...Out, H]>
  : [...Out, ...S];

/** History: events already committed on a stream before the story starts. */
const given = <A extends Aggregate.Any>(
  ref: Aggregate.Ref<A>,
  ...events: ReadonlyArray<Aggregate.EventOf<A>>
): StepOf<"Given"> => ({
  _tag: "Given",
  ref,
  events: events as ReadonlyArray<{ readonly _tag: string }>,
});

/** Send a command. Its policies run until they finish or suspend on an external system call. */
const when = <A extends Aggregate.Any, Cmd extends Aggregate.CommandOf<A>>(
  ref: Aggregate.Ref<A>,
  command: Cmd,
  options?: { readonly commandId?: string },
): WhenStep<CommandClassOf<A, Cmd>> => ({
  _tag: "When",
  ref,
  command: command as { readonly _tag: string },
  commandId: options?.commandId,
});

/** The next events committed on a stream. With no events: nothing new was committed. */
const then = <A extends Aggregate.Any>(
  ref: Aggregate.Ref<A>,
  ...events: ReadonlyArray<Aggregate.EventOf<A>>
): StepOf<"Then"> => ({
  _tag: "Then",
  ref,
  events: events as ReadonlyArray<{ readonly _tag: string }>,
});

/**
 * The last command was rejected with exactly this rejection. It must be one
 * the last `when` command declares in `rejects`.
 */
const rejected = <R extends { readonly _tag: string }>(rejection: R): RejectedStep<R> => ({
  _tag: "Rejected",
  rejection,
});

/** The last command's reply, of the type the last `when` command declares. */
const replied = <A>(reply: A): RepliedStep<A> => ({ _tag: "Replied", reply });

/** Assert on an aggregate instance's current state: an expected (partial) state, or a function. */
const state = <A extends Aggregate.Any>(
  ref: Aggregate.Ref<A>,
  expected: Partial<Aggregate.StateOf<A>> | ((state: Aggregate.StateOf<A>) => void),
): StepOf<"State"> => ({ _tag: "State", ref, expected });

/** Assert on a view key: an expected (partial) state, a function, or {@link none}. */
const view = <V extends View.Any>(
  view: V,
  key: Key.RefOf<View.KeyOf<V>>,
  expected: Partial<View.StateOf<V>> | ((state: View.StateOf<V>) => void) | typeof none,
): StepOf<"View"> => ({ _tag: "View", view, key, expected });

/**
 * Assert on every event a view key has emitted: the expected (partial) events
 * in order, or a function over the entries (each event with the state after it).
 */
const emitted = <V extends View.Any>(
  view: V,
  key: Key.RefOf<View.KeyOf<V>>,
  expected:
    | ReadonlyArray<Partial<View.EventOf<V>>>
    | ((entries: ReadonlyArray<View.Entry<View.StateOf<V>, View.EventOf<V>>>) => void),
): StepOf<"Emitted"> => ({ _tag: "Emitted", view, key, expected });

/**
 * The next entries appended to a stream key (by its projection). With no
 * events: nothing new was appended.
 */
const streamed = <S extends DomainStream.Any>(
  stream: S,
  key: Key.RefOf<DomainStream.KeyOf<S>>,
  ...events: ReadonlyArray<DomainStream.EventOf<S>>
): StepOf<"Streamed"> => ({
  _tag: "Streamed",
  stream,
  key,
  events: events as ReadonlyArray<{ readonly _tag: string }>,
});

/**
 * A call to an external system was made with these (partial) arguments:
 * `Story.call(Payments.refund, { settlementId: "st_1" })`. Every call needs
 * one: a stubbed call before it's answered, a real call before it's asserted.
 * Each call is matched once, earliest first. With a tag first, the tag names
 * that call, so a later step can answer or assert exactly it.
 */
const callStep: {
  <Args>(op: ExternalSystem.Op<Args, any>, args: Partial<Args>): StepOf<"Call">;
  <Args>(tag: string, op: ExternalSystem.Op<Args, any>, args: Partial<Args>): StepOf<"Call">;
} = (...a: ReadonlyArray<any>): StepOf<"Call"> =>
  typeof a[0] === "string"
    ? { _tag: "Call", tag: a[0], op: a[1], args: a[2] }
    : { _tag: "Call", tag: undefined, op: a[0], args: a[1] };

/** Answer a pending call with an exit; the tag, when given, comes first. */
const answer = (
  a: ReadonlyArray<any>,
  exit: (value: any) => Exit.Exit<unknown, unknown>,
): StepOf<"Answer"> =>
  typeof a[0] === "string"
    ? { _tag: "Answer", tag: a[0], op: a[1], exit: exit(a[2]) }
    : { _tag: "Answer", tag: undefined, op: a[0], exit: exit(a[1]) };

/**
 * Answer an external system call a `call` step has checked. With a tag
 * first, answers the call a `call` step tagged; without one, answers the only
 * pending call to the operation, and fails if several are pending.
 */
const succeed: {
  <Success>(op: ExternalSystem.Op<any, Success>, value: Success): StepOf<"Answer">;
  <Success>(tag: string, op: ExternalSystem.Op<any, Success>, value: Success): StepOf<"Answer">;
} = (...a: ReadonlyArray<any>): StepOf<"Answer"> => answer(a, Exit.succeed);

/**
 * Fail an external system call with one of the operation's declared errors,
 * as when the vendor refuses. Finds the call the same way `succeed` does.
 */
const fail: {
  <Error>(op: ExternalSystem.Op<any, any, Error>, error: NoInfer<Error>): StepOf<"Answer">;
  <Error>(
    tag: string,
    op: ExternalSystem.Op<any, any, Error>,
    error: NoInfer<Error>,
  ): StepOf<"Answer">;
} = (...a: ReadonlyArray<any>): StepOf<"Answer"> => answer(a, Exit.fail);

/**
 * Fail an external system call with a defect, as when the transport breaks.
 * Finds the call the same way `succeed` does.
 */
const die: {
  (op: ExternalSystem.Op, defect: unknown): StepOf<"Answer">;
  (tag: string, op: ExternalSystem.Op, defect: unknown): StepOf<"Answer">;
} = (...a: ReadonlyArray<any>): StepOf<"Answer"> => answer(a, Exit.die);

/** Assert how a real call to a system that is not stubbed ended; the tag, when given, comes first. */
const outcome = (a: ReadonlyArray<any>, expected: (value: any) => any): StepOf<"Returned"> =>
  typeof a[0] === "string"
    ? { _tag: "Returned", tag: a[0], op: a[1], expected: expected(a[2]) }
    : { _tag: "Returned", tag: undefined, op: a[0], expected: expected(a[1]) };

/**
 * A real call to an external system that is not stubbed returned this value.
 * Finds the call the way `succeed` does: by tag, or the only unasserted call
 * to the operation. Every real call needs a `call` step, then one of
 * `returned`, `failed` or `died`.
 */
const returned: {
  <Success>(op: ExternalSystem.Op<any, Success>, value: Success): StepOf<"Returned">;
  <Success>(tag: string, op: ExternalSystem.Op<any, Success>, value: Success): StepOf<"Returned">;
} = (...a: ReadonlyArray<any>): StepOf<"Returned"> =>
  outcome(a, (value) => ({ _tag: "Success", value }));

/** A real call to an external system that is not stubbed failed with this declared error. */
const failed: {
  <Error>(op: ExternalSystem.Op<any, any, Error>, error: NoInfer<Error>): StepOf<"Returned">;
  <Error>(
    tag: string,
    op: ExternalSystem.Op<any, any, Error>,
    error: NoInfer<Error>,
  ): StepOf<"Returned">;
} = (...a: ReadonlyArray<any>): StepOf<"Returned"> =>
  outcome(a, (error) => ({ _tag: "Failure", error }));

/** A real call to an external system that is not stubbed died with a defect. */
const died: {
  (op: ExternalSystem.Op): StepOf<"Returned">;
  (tag: string, op: ExternalSystem.Op): StepOf<"Returned">;
} = (...a: ReadonlyArray<any>): StepOf<"Returned"> =>
  typeof a[0] === "string"
    ? { _tag: "Returned", tag: a[0], op: a[1], expected: { _tag: "Died" } }
    : { _tag: "Returned", tag: undefined, op: a[0], expected: { _tag: "Died" } };

/** Move the clock: later commands are stamped with it, and scheduled commands now due fire. */
const clock = (at: string | number | DateTime.DateTime): StepOf<"Clock"> => ({ _tag: "Clock", at });

/** Move the clock forward by a duration, like `"1 day"`: the same as `clock` at the current time plus `by`. */
const advance = (by: Duration.Input): StepOf<"Advance"> => ({ _tag: "Advance", by });

type SagaClientOf<S> = S extends Context.Key<any, infer C> ? C : never;
type SagaKeyOf<S> =
  SagaClientOf<S> extends Saga.Client<infer K, any, any, any> ? K | { readonly id: K } : never;
type SagaStatusOf<S> =
  SagaClientOf<S> extends Saga.Client<any, any, infer A, infer E> ? Saga.Status<A, E> : never;

/** Complete a `DurableDeferred` a saga run waits on, then let it run. */
const signal = <S extends Saga.Any, Success extends Schema.Constraint>(
  saga: S,
  key: SagaKeyOf<S>,
  deferred: DurableDeferred.DurableDeferred<Success, any>,
  value: Success["Type"],
): StepOf<"Signal"> => ({ _tag: "Signal", saga, key, deferred, value });

/**
 * Check where a saga run is: running, completed with a result, rejected,
 * interrupted, or died. `{ _tag: "Died" }` matches any defect; with a
 * `defect`, it must read the same.
 */
const saga = <S extends Saga.Any>(
  saga: S,
  key: SagaKeyOf<S>,
  expected: SagaStatusOf<S> | { readonly _tag: "Died" },
): StepOf<"Saga"> => ({
  _tag: "Saga",
  saga,
  key,
  expected: expected as Saga.Status<unknown, unknown>,
});

/** A saga status, in a form to compare: rejections encoded, defects as text. */
const statusJson = (status: Saga.Status<unknown, unknown> | { readonly _tag: "Died" }) =>
  status._tag === "Rejected"
    ? { _tag: "Rejected", rejection: encodeInstance(status.rejection as { readonly _tag: string }) }
    : status._tag === "Died"
      ? "defect" in status
        ? { _tag: "Died", defect: String(status.defect) }
        : { _tag: "Died" }
      : status;

/**
 * Provide a service to subsequent commands, as their middleware would (for
 * example the current actor). Replaces any earlier value of the same service.
 */
const provide = <I, S>(service: Context.Key<I, S>, value: S): ProvideStep<I> => ({
  _tag: "Provide",
  service: service as unknown as Context.Key<unknown, unknown>,
  value,
});

const normalize = (value: unknown, redact = false): unknown => {
  if (redact && Redacted.isRedacted(value)) return "<redacted>";
  if (DateTime.isDateTime(value)) return DateTime.formatIso(value);
  if (Array.isArray(value)) return value.map((v) => normalize(v, redact));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = normalize((value as any)[key], redact);
    return out;
  }
  return value;
};

/** JSON for a failure message: redacted values print as `<redacted>`. */
const show = (value: unknown) => JSON.stringify(normalize(value, true));

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** A short, one-line form of a value: `Tag { field: value }`, nested values elided. */
const brief = (value: unknown, depth = 0): string => {
  if (Redacted.isRedacted(value)) return "<redacted>";
  if (DateTime.isDateTime(value)) return DateTime.formatIso(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return JSON.stringify(clip(value, 24));
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value))
    return depth > 0 ? `[${value.length}]` : `[${value.map((v) => brief(v, 1)).join(", ")}]`;
  const tag = typeof (value as any)._tag === "string" ? ((value as any)._tag as string) : undefined;
  if (depth > 1) return tag ?? "{…}";
  const fields = Object.keys(value)
    .filter((key) => key !== "_tag")
    .map((key) => `${key}: ${brief((value as any)[key], depth + 1)}`);
  const body = fields.length > 0 ? `{ ${fields.join(", ")} }` : tag ? "" : "{}";
  return tag && body ? `${tag} ${body}` : (tag ?? body);
};

const summarize = (value: unknown) => clip(brief(value), 80);
const summarizeAll = (values: ReadonlyArray<unknown>, none = "nothing new") =>
  values.length === 0 ? none : clip(values.map((v) => brief(v)).join(", "), 80);

const refName = (ref: Aggregate.Ref) => `${ref.aggregate}/${ref.id}`;
const callName = (tag: string | undefined, op: ExternalSystem.Op) =>
  `${tag === undefined ? "" : `"${tag}" `}${op.system}.${op.op}`;

/** A `clock` step's time in epoch milliseconds; `NaN` for a string that is not a time. */
const clockMillis = (at: string | number | DateTime.DateTime) =>
  typeof at === "number"
    ? at
    : typeof at === "string"
      ? Date.parse(at)
      : DateTime.toEpochMillis(at);

/** An `advance` step's duration; `undefined` for an input that is not a finite duration. */
const advanceDuration = (by: Duration.Input) =>
  Option.getOrUndefined(Option.filter(Duration.fromInput(by), Duration.isFinite));

const showDurationInput = (by: Duration.Input): string =>
  typeof by === "string" ? by : Formatter.format(by);

/** A one-line summary of a step, before it runs. */
const describeStep = (s: Step): string => {
  switch (s._tag) {
    case "Advance": {
      const by = advanceDuration(s.by);
      if (by === undefined) return showDurationInput(s.by);
      return `${Duration.isNegative(by) ? "" : "+"}${Duration.format(by)}`;
    }
    case "Clock": {
      const at = clockMillis(s.at);
      return Number.isNaN(at) ? String(s.at) : new Date(at).toISOString();
    }
    case "Provide":
      return `${s.service.key} = ${summarize(s.value)}`;
    case "Given":
    case "Then":
      return `${refName(s.ref)}: ${summarizeAll(s.events)}`;
    case "When":
      return `${refName(s.ref)}: ${summarize(s.command)}`;
    case "Rejected":
      return summarize(s.rejection);
    case "Replied":
      return summarize(s.reply);
    case "State":
      return `${refName(s.ref)}${typeof s.expected === "function" ? "" : `: ${summarize(s.expected)}`}`;
    case "View":
      return `${s.view.viewName}(${Aggregate.targetId(s.key)})${s.expected === none ? ": none" : typeof s.expected === "function" ? "" : `: ${summarize(s.expected)}`}`;
    case "Emitted":
      return `${s.view.viewName}(${Aggregate.targetId(s.key)})${typeof s.expected === "function" ? "" : `: ${summarizeAll(s.expected as ReadonlyArray<unknown>)}`}`;
    case "Streamed":
      return `${s.stream.streamName}/${Aggregate.targetId(s.key)}: ${summarizeAll(s.events)}`;
    case "Call":
      return `${callName(s.tag, s.op)} ${summarize(s.args)}`;
    case "Answer":
      return `${callName(s.tag, s.op)} → ${
        Exit.isSuccess(s.exit)
          ? summarize(s.exit.value)
          : Option.match(Cause.findErrorOption(s.exit.cause), {
              onSome: (error) => `fail ${summarize(error)}`,
              onNone: () => "die",
            })
      }`;
    case "Returned":
      return `${callName(s.tag, s.op)} → ${
        s.expected._tag === "Success"
          ? summarize(s.expected.value)
          : s.expected._tag === "Failure"
            ? `failed ${summarize(s.expected.error)}`
            : "died"
      }`;
    case "Signal":
      return `${s.saga.sagaName} ${summarize(s.key)}: ${summarize(s.value)}`;
    case "Saga":
      return `${s.saga.sagaName} ${summarize(s.key)}: ${s.expected._tag}`;
  }
};

/** The story, step by step, with the failed step marked: the tail of a failure message. */
const renderReport = (
  failure: StepFailed,
  steps: ReadonlyArray<StepReport>,
  events: Readonly<Record<string, ReadonlyArray<string>>>,
): string => {
  const width = String(steps.length).length;
  const lines: Array<string> = [];
  for (const s of steps) {
    const mark = s.status === "passed" ? "✓" : s.status === "failed" ? "✗" : " ";
    const head = `  ${mark} ${String(s.step).padStart(width)} ${s.kind.padEnd(10)} `;
    const indent = " ".repeat(head.length);
    if (s.status !== "failed") {
      lines.push(head + s.summary);
      continue;
    }
    if (failure.expected !== undefined && failure.actual !== undefined) {
      // `Ref: expected X` / `     got      Y`, with the ref (if any) kept in front.
      const label = failure.label === undefined ? "" : `${failure.label}: `;
      lines.push(`${head}${label}expected ${failure.expected}`);
      lines.push(`${indent}${" ".repeat(label.length)}got      ${failure.actual}`);
    } else {
      lines.push(head + s.summary);
    }
    if (failure.detail !== undefined) lines.push(indent + failure.detail);
  }
  if (failure.atEnd) {
    const head = `  ✗ ${" ".repeat(width)} ${"end".padEnd(10)} `;
    const detail = failure.detail?.split("\n") ?? [];
    lines.push(detail.length > 0 ? head + detail[0] : head.trimEnd());
    for (const line of detail.slice(1)) lines.push(" ".repeat(head.length) + line);
  }
  lines.push("  events so far");
  const streams = Object.entries(events);
  if (streams.length === 0) lines.push("    nothing");
  for (const [stream, tags] of streams)
    lines.push(`    ${stream}: ${tags.length === 0 ? "nothing" : clip(tags.join(" → "), 120)}`);
  return lines.join("\n");
};

const encodeInstance = (value: { readonly _tag: string }): unknown => {
  const schema = (value as any).constructor as Schema.Top;
  // oxlint-disable-next-line effecttsgo/schema-sync -- encodes a value for a sync story report
  return Schema.encodeUnknownSync(Schema.toCodecJson(schema as any) as any)(value);
};

const equal = (a: unknown, b: unknown) => show(a) === show(b);

/** A tagged error by its encoded fields; anything else as it is. */
const errorJson = (error: unknown): unknown => {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    try {
      return encodeInstance(error as { readonly _tag: string });
    } catch {
      return normalize(error);
    }
  }
  return normalize(error);
};

const exitJson = (
  exit: Exit.Exit<unknown, unknown>,
):
  | { readonly _tag: "Success"; readonly value: unknown }
  | { readonly _tag: "Failure"; readonly error: unknown }
  | { readonly _tag: "Died"; readonly defect: string } => {
  if (Exit.isSuccess(exit)) return { _tag: "Success", value: normalize(exit.value) };
  const error = Cause.findErrorOption(exit.cause);
  return Option.isSome(error)
    ? { _tag: "Failure", error: errorJson(error.value) }
    : { _tag: "Died", defect: String(Cause.squash(exit.cause)) };
};

const partial = (expected: unknown, actual: unknown): boolean => {
  const e = normalize(expected);
  const a = normalize(actual);
  if (e !== null && typeof e === "object" && !Array.isArray(e)) {
    if (a === null || typeof a !== "object") return false;
    return Object.keys(e).every((k) => partial((e as any)[k], (a as any)[k]));
  }
  return JSON.stringify(e) === JSON.stringify(a);
};

interface PendingCall {
  readonly system: string;
  readonly op: string;
  readonly args: unknown;
  readonly deferred: Deferred.Deferred<unknown, unknown>;
  /** The name its `call` step gave it, if any. */
  tag: string | undefined;
  /** Whether a `call` step checked its arguments. */
  expected: boolean;
}

interface ObservedCall {
  readonly system: string;
  readonly op: string;
  readonly args: unknown;
  /** How the call ended; undefined while it runs. */
  exit: Exit.Exit<unknown, unknown> | undefined;
  readonly done: Deferred.Deferred<void>;
  /** The name its `call` step gave it, if any. */
  tag: string | undefined;
  /** Whether a `call` step matched it. */
  expected: boolean;
}

/** Options for {@link make}. */
interface StoryOptions<Policies, LE, LR, Systems> {
  /** The policies' and projections' Layers. Required when the model has either. */
  readonly layer?: Layer.Layer<Policies, LE, LR>;
  /**
   * External systems to fake. Each call to one waits until the story answers it
   * with `succeed`, `fail` or `die`. Systems not listed are called for real,
   * through the Layers you provide to the story, and the story asserts what
   * each call returned with `returned`, `failed` or `died`.
   */
  readonly stub?: ReadonlyArray<Systems>;
}

/**
 * Create a story runner for a Domain. A story is a sequence of steps run
 * against an in-memory host: policies run for real, calls to stubbed external
 * systems suspend until the story answers them, and calls to the others run
 * through the Layers you provide while the story records them.
 *
 * **Example:** A story
 * ```typescript
 * const story = Story.make(Bank, {
 *   layer: BankPolicies,
 *   stub: [FraudCheck, Payments],
 * });
 *
 * it.effect("withdraw replies with the new balance", () =>
 *   story(
 *     Story.given(a1, new AccountOpened({ ... }), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
 *     Story.provide(CurrentActor, sam),
 *     Story.when(a1, new WithdrawMoney({ amount: 30 })),
 *     Story.then(a1, new MoneyWithdrawn({ amount: 30, balanceAfter: 70 })),
 *     Story.replied({ balance: 70 }),
 *   ),
 * );
 * ```
 */
const make =
  <
    Name extends string,
    Provided,
    Policies,
    LE = never,
    LR = never,
    Systems extends ExternalSystem.Any = never,
  >(
    domain: Model.ModelClass<Name, Provided, Policies>,
    ...[options = {}]: [Policies] extends [never]
      ? [options?: StoryOptions<Policies, LE, LR, Systems>]
      : [options: StoryOptions<Policies, LE, LR, Systems> & { readonly layer: unknown }]
  ) =>
  <const S extends ReadonlyArray<Step>>(
    ...steps: S & Checked<S>
  ): Effect.Effect<
    void,
    StoryFailure | LE,
    Exclude<LR, Provided | ExternalSystem.Identifier<Systems> | WorkflowEngine.WorkflowEngine>
  > =>
    Effect.gen(function* () {
      const clockState = { now: Date.parse("2026-01-01T00:00:00.000Z") };
      const platform = InMemory.make({ manual: true, now: () => clockState.now });
      const calls: Array<PendingCall> = [];
      const observed: Array<ObservedCall> = [];
      const stubbed = new Set((options.stub ?? []).map((system) => system.systemName));
      const recorder: ExternalSystem.CallRecorder = {
        record: (system, op, args, call) =>
          Effect.gen(function* () {
            const entry: ObservedCall = {
              system,
              op,
              args,
              exit: undefined,
              done: yield* Deferred.make<void>(),
              tag: undefined,
              expected: false,
            };
            observed.push(entry);
            return yield* call.pipe(
              Effect.onExit((exit) =>
                Effect.suspend(() => {
                  entry.exit = exit;
                  return Deferred.succeed(entry.done, undefined);
                }),
              ),
            );
          }),
      };
      const systemLayers = (options.stub ?? []).map((system) =>
        Layer.effect(
          system as Context.Key<unknown, unknown>,
          Effect.map(
            ExternalSystem.compileChecks(system.systemName, system.ops),
            (checks) =>
              ExternalSystem.observeOps(
                system.systemName,
                // The story's answers are checked like an adapter's.
                ExternalSystem.validateOps(
                  checks,
                  Object.fromEntries(
                    Object.keys(system.ops).map((op) => [
                      op,
                      (args: unknown) =>
                        platform.control.suspended(
                          Effect.gen(function* () {
                            const deferred = yield* Deferred.make<unknown, unknown>();
                            calls.push({
                              system: system.systemName,
                              op,
                              args,
                              deferred,
                              tag: undefined,
                              expected: false,
                            });
                            return yield* Deferred.await(deferred);
                          }),
                        ),
                    ]),
                  ),
                ),
              ) as never,
          ),
        ),
      );
      const systems = Layer.mergeAll(Layer.empty, ...systemLayers);
      const policies = (
        options.layer ?? (Layer.empty as unknown as Layer.Layer<Policies, LE, LR>)
      ).pipe(Layer.provide(systems));
      const hosted = domain
        .layer(policies)
        .pipe(Layer.provide(Layer.mergeAll(platform.layer, systems)));

      // The aggregates the story touched, for the report's "events so far".
      const touched = new Map<string, Aggregate.Ref>();

      const run = Effect.gen(function* () {
        const internals = yield* Model.Internals;
        const cursors = new Map<string, number>();
        // The step that committed each event, by `Aggregate/id#index`.
        const committedAt = new Map<string, number>();
        const attribute = (step: number) => {
          for (const { aggregate, id, index } of platform.control.commits.slice(committedAt.size))
            committedAt.set(`${aggregate}/${id}#${index}`, step);
        };
        let last:
          | { readonly _tag: "Accepted"; readonly receipt: Aggregate.Receipt }
          | { readonly _tag: "Rejected"; readonly rejection: { readonly _tag: string } }
          | undefined;
        let unassertedRejection:
          | { readonly step: number; readonly rejection: { readonly _tag: string } }
          | undefined;
        let provided = Context.empty() as Context.Context<unknown>;
        const assertedDeaths = new Set<string>();

        const storeOf = (ref: Aggregate.Ref) => internals.aggregates.get(ref.aggregate)!;
        const committed = (ref: Aggregate.Ref) =>
          storeOf(ref).events?.(ref.id as string) ?? Effect.succeed([]);

        const settle = (step: number) =>
          Effect.gen(function* () {
            for (let i = 0; i < 10_000; i++) {
              // Real calls take real time: wait for them instead of spinning.
              for (const call of observed) {
                if (call.exit === undefined) yield* Deferred.await(call.done);
              }
              yield* platform.control.drain;
              yield* Effect.yieldNow;
              if (yield* platform.control.idle) {
                yield* Effect.yieldNow;
                yield* platform.control.drain;
                if (yield* platform.control.idle) {
                  if (platform.control.failures.length > 0) {
                    return yield* new StepFailed({
                      step,
                      message: `a policy or projection failed: ${String(platform.control.failures[0])}`,
                    });
                  }
                  return;
                }
              }
            }
            return yield* new StepFailed({
              step,
              message: "the domain did not settle (a policy or projection is looping?)",
            });
          });

        const rejectionNotAsserted = (rejected: NonNullable<typeof unassertedRejection>) =>
          new StepFailed({
            step: rejected.step,
            message: `the command was rejected with ${rejected.rejection._tag}, which no step asserts`,
            detail: `rejected ${summarize(rejected.rejection)}`,
          });

        for (const [index, s] of steps.entries()) {
          const step = index + 1;
          attribute(index);
          const fail = (
            message: string,
            compared?: {
              readonly expected: string;
              readonly actual: string;
              readonly label?: string;
            },
          ) => new StepFailed({ step, message: `${s._tag}: ${message}`, ...compared });
          if (unassertedRejection && s._tag !== "Rejected") {
            return yield* rejectionNotAsserted(unassertedRejection);
          }
          if ("ref" in s) touched.set(refName(s.ref), s.ref);
          switch (s._tag) {
            case "Clock": {
              const at = clockMillis(s.at);
              if (Number.isNaN(at)) return yield* fail(`${String(s.at)} is not a time`);
              // Once a step has run at the current time, the clock only moves forward.
              const started = steps.slice(0, index).some((earlier) => earlier._tag !== "Provide");
              if (started && at < clockState.now) {
                const now = new Date(clockState.now).toISOString();
                return yield* fail(
                  `the clock cannot move back, from ${now} to ${new Date(at).toISOString()}`,
                  { expected: `${now} or later`, actual: new Date(at).toISOString() },
                );
              }
              clockState.now = at;
              // Scheduled commands that are now due fire, and their policies run.
              yield* settle(step);
              break;
            }
            case "Advance": {
              const by = advanceDuration(s.by);
              if (by === undefined)
                return yield* fail(`${showDurationInput(s.by)} is not a duration`);
              if (Duration.isNegative(by)) {
                return yield* fail(`the clock only moves forward, not by ${Duration.format(by)}`);
              }
              clockState.now += Duration.toMillis(by);
              yield* settle(step);
              break;
            }
            case "Provide": {
              provided = Context.add(provided, s.service, s.value);
              break;
            }
            case "Given": {
              const store = storeOf(s.ref);
              if (!store.seed) return yield* fail("the platform cannot seed events");
              yield* store.seed(
                s.ref.id as string,
                yield* Effect.forEach(s.events, internals.kernel.encodeEvent),
              );
              cursors.set(`${s.ref.aggregate}/${s.ref.id}`, (yield* committed(s.ref)).length);
              yield* settle(step);
              break;
            }
            case "When": {
              const client = yield* Aggregate.refClass(s.ref) as unknown as Context.Key<
                never,
                Aggregate.ClientImpl
              >;
              const result = yield* client
                .send(s.ref, s.command, { commandId: s.commandId ?? `story:${step}` })
                .pipe(Effect.provide(provided), Effect.result);
              if (result._tag === "Success") {
                last = { _tag: "Accepted", receipt: result.success };
              } else {
                last = { _tag: "Rejected", rejection: result.failure as { readonly _tag: string } };
                unassertedRejection = { step, rejection: last.rejection };
              }
              yield* settle(step);
              break;
            }
            case "Then": {
              const stream = `${s.ref.aggregate}/${s.ref.id}`;
              const events = yield* committed(s.ref);
              const from = cursors.get(stream) ?? 0;
              const actual = events
                .slice(from, from + Math.max(s.events.length, 1))
                .map((e) => e.event);
              const expected = s.events.map(encodeInstance);
              // Decoded, so redacted fields stay redacted in the message.
              const got = yield* Effect.forEach(events.slice(from), (e) =>
                internals.kernel.decodeEvent(e.event),
              );
              const compared = {
                label: stream,
                expected: summarizeAll(s.events),
                actual: summarizeAll(got),
              };
              if (s.events.length === 0) {
                if (events.length > from) {
                  return yield* fail(
                    `expected no new events on ${stream}, got ${show(got)}`,
                    compared,
                  );
                }
                break;
              }
              if (!equal(actual.slice(0, expected.length), expected)) {
                return yield* fail(
                  `on ${stream}\n  expected ${show(s.events)}\n  actual   ${show(got)}`,
                  compared,
                );
              }
              cursors.set(stream, from + expected.length);
              break;
            }
            case "Rejected": {
              if (last?._tag !== "Rejected")
                return yield* fail(
                  `expected a rejection, the command was ${last ? "accepted" : "never sent"}`,
                  {
                    expected: summarize(s.rejection),
                    actual: last ? `accepted ${summarize(last.receipt.reply)}` : "never sent",
                  },
                );
              const expected = encodeInstance(s.rejection);
              const actual = encodeInstance(last.rejection);
              if (!equal(expected, actual))
                return yield* fail(`expected ${show(s.rejection)}, got ${show(last.rejection)}`, {
                  expected: summarize(s.rejection),
                  actual: summarize(last.rejection),
                });
              unassertedRejection = undefined;
              break;
            }
            case "Replied": {
              if (last?._tag !== "Accepted")
                return yield* fail("the last command was not accepted");
              if (!equal(last.receipt.reply, s.reply)) {
                return yield* fail(`expected ${show(s.reply)}, got ${show(last.receipt.reply)}`, {
                  expected: summarize(s.reply),
                  actual: summarize(last.receipt.reply),
                });
              }
              break;
            }
            case "State": {
              const client = yield* Aggregate.refClass(s.ref) as unknown as Context.Key<
                never,
                Aggregate.ClientImpl
              >;
              const current = yield* client.state(s.ref);
              if (typeof s.expected === "function") {
                const assert = s.expected as (state: unknown) => void;
                yield* Effect.try({ try: () => assert(current), catch: (e) => fail(String(e)) });
              } else if (!partial(s.expected, current)) {
                const label = refName(s.ref);
                return yield* fail(
                  `${label}\n  expected ${show(s.expected)}\n  actual   ${show(current)}`,
                  { label, expected: summarize(s.expected), actual: summarize(current) },
                );
              }
              break;
            }
            case "View": {
              const host = yield* s.view as unknown as Context.Key<
                never,
                View.Host<unknown, Key.Any, unknown>
              >;
              const current = yield* host.query(s.key).pipe(Effect.orDie);
              if (s.expected === none) {
                if (Option.isSome(current))
                  return yield* fail(
                    `expected ${s.view.viewName}(${Aggregate.targetId(s.key)}) to not exist, got ${show(current.value)}`,
                    {
                      label: `${s.view.viewName}(${Aggregate.targetId(s.key)})`,
                      expected: "none",
                      actual: summarize(current.value),
                    },
                  );
                break;
              }
              const viewLabel = `${s.view.viewName}(${Aggregate.targetId(s.key)})`;
              if (Option.isNone(current))
                return yield* fail(`${viewLabel} does not exist`, {
                  label: viewLabel,
                  expected: typeof s.expected === "function" ? "a state" : summarize(s.expected),
                  actual: "none",
                });
              if (typeof s.expected === "function") {
                const assert = s.expected as (state: unknown) => void;
                yield* Effect.try({
                  try: () => assert(current.value),
                  catch: (e) => fail(String(e)),
                });
              } else if (!partial(s.expected, current.value)) {
                return yield* fail(
                  `${viewLabel}\n  expected ${show(s.expected)}\n  actual   ${show(current.value)}`,
                  {
                    label: viewLabel,
                    expected: summarize(s.expected),
                    actual: summarize(current.value),
                  },
                );
              }
              break;
            }
            case "Emitted": {
              const host = yield* s.view as unknown as Context.Key<
                never,
                View.Host<unknown, Key.Any, unknown>
              >;
              const { entries } = yield* host.list(s.key);
              if (typeof s.expected === "function") {
                const assert = s.expected as (entries: ReadonlyArray<unknown>) => void;
                yield* Effect.try({ try: () => assert(entries), catch: (e) => fail(String(e)) });
              } else {
                const expected = s.expected as ReadonlyArray<unknown>;
                const events = entries.map((entry) => entry.event);
                const ok =
                  expected.length === events.length &&
                  expected.every((e, i) => partial(e, events[i]));
                if (!ok)
                  return yield* fail(
                    `${s.view.viewName}(${Aggregate.targetId(s.key)})\n  expected ${show(expected)}\n  actual   ${show(events)}`,
                  );
              }
              break;
            }
            case "Streamed": {
              const store = internals.streams.get(s.stream.streamName)!;
              const key = Aggregate.targetId(s.key);
              const id = `${s.stream.streamName}/${key}`;
              const entries = yield* store.list(key);
              const from = cursors.get(id) ?? 0;
              const actual = entries.slice(from).map((e) => e.event);
              const expected = s.events.map(encodeInstance);
              if (s.events.length === 0) {
                if (actual.length > 0)
                  return yield* fail(`expected nothing new on ${id}, got ${show(actual)}`);
                break;
              }
              if (!equal(actual.slice(0, expected.length), expected)) {
                return yield* fail(
                  `on ${id}\n  expected ${show(expected)}\n  actual   ${show(actual)}`,
                );
              }
              cursors.set(id, from + expected.length);
              break;
            }
            case "Call": {
              const name = `${s.op.system}.${s.op.op}`;
              if (s.tag !== undefined && observed.some((c) => c.tag === s.tag)) {
                return yield* fail(`"${s.tag}" already names a call`);
              }
              if (!stubbed.has(s.op.system)) {
                const made = observed.filter((c) => c.system === s.op.system && c.op === s.op.op);
                // Each real call is matched once, in the order calls were made.
                const match = made.find((c) => !c.expected && partial(s.args, c.args));
                if (!match) {
                  return yield* fail(
                    `no unmatched call to ${name} matches ${show(s.args)}; made: ${show(made.map((c) => c.args))}`,
                  );
                }
                match.expected = true;
                match.tag = s.tag;
                break;
              }
              const pending = calls.filter((c) => c.system === s.op.system && c.op === s.op.op);
              // Calls are kept in the order they were made: each is matched once, earliest first.
              const match = pending.find((c) => !c.expected && partial(s.args, c.args));
              if (!match) {
                return yield* fail(
                  `no unmatched pending call to ${name} matches ${show(s.args)}; pending: ${show(pending.map((c) => c.args))}`,
                );
              }
              if (s.tag !== undefined) {
                if (calls.some((c) => c.tag === s.tag)) {
                  return yield* fail(`"${s.tag}" already names a pending call`);
                }
                match.tag = s.tag;
              }
              match.expected = true;
              break;
            }
            case "Signal": {
              const client = yield* s.saga as unknown as Context.Key<
                never,
                Saga.Client<unknown, unknown, unknown, unknown>
              >;
              yield* client.get(s.key).signal(s.deferred as never, s.value);
              yield* settle(step);
              break;
            }
            case "Saga": {
              const client = yield* s.saga as unknown as Context.Key<
                never,
                Saga.Client<unknown, unknown, unknown, unknown>
              >;
              const run = client.get(s.key);
              const actual = yield* run.status;
              // `{ _tag: "Died" }` matches any defect.
              const compared =
                actual._tag === "Died" && !("defect" in s.expected)
                  ? { _tag: "Died" as const }
                  : actual;
              if (!equal(statusJson(compared), statusJson(s.expected))) {
                return yield* fail(
                  `${s.saga.sagaName}\n  expected ${show(statusJson(s.expected))}\n  actual   ${show(statusJson(actual))}`,
                );
              }
              if (actual._tag === "Died")
                // The engine names a model's sagas `<model>/<saga>`.
                assertedDeaths.add(`${domain.modelName}/${s.saga.sagaName}/${run.executionId}`);
              break;
            }
            case "Answer": {
              const name = `${s.op.system}.${s.op.op}`;
              if (!stubbed.has(s.op.system)) {
                return yield* fail(
                  `${s.op.system} is not stubbed, so its calls run for real; assert how one ended with returned, failed or died`,
                );
              }
              let call: PendingCall | undefined;
              if (s.tag !== undefined) {
                call = calls.find((c) => c.tag === s.tag);
                if (!call) {
                  const tags = calls.flatMap((c) => (c.tag === undefined ? [] : [`"${c.tag}"`]));
                  return yield* fail(
                    `no pending call is named "${s.tag}"; named: ${tags.length > 0 ? tags.join(", ") : "none"}`,
                  );
                }
                if (call.system !== s.op.system || call.op !== s.op.op) {
                  return yield* fail(
                    `"${s.tag}" names a call to ${call.system}.${call.op}, not ${name}`,
                  );
                }
              } else {
                const pending = calls.filter((c) => c.system === s.op.system && c.op === s.op.op);
                if (pending.length === 0) return yield* fail(`no pending call to ${name}`);
                if (pending.length > 1) {
                  return yield* fail(
                    `${pending.length} pending calls to ${name}; name each with call("<tag>", ...) and answer it by tag`,
                  );
                }
                call = pending[0];
              }
              if (!call!.expected) {
                return yield* fail(
                  `${name}(${show(call!.args)}) is answered before a call step checks its arguments`,
                );
              }
              calls.splice(calls.indexOf(call!), 1);
              yield* Deferred.done(call!.deferred, s.exit);
              yield* settle(step);
              break;
            }
            case "Returned": {
              const name = `${s.op.system}.${s.op.op}`;
              if (stubbed.has(s.op.system)) {
                return yield* fail(
                  `${s.op.system} is stubbed; answer its calls with succeed, fail or die`,
                );
              }
              let call: ObservedCall | undefined;
              if (s.tag !== undefined) {
                call = observed.find((c) => c.tag === s.tag);
                if (!call) return yield* fail(`no call is named "${s.tag}"`);
                if (call.system !== s.op.system || call.op !== s.op.op) {
                  return yield* fail(
                    `"${s.tag}" names a call to ${call.system}.${call.op}, not ${name}`,
                  );
                }
              } else {
                const made = observed.filter((c) => c.system === s.op.system && c.op === s.op.op);
                if (made.length === 0) return yield* fail(`no unasserted call to ${name}`);
                if (made.length > 1) {
                  return yield* fail(
                    `${made.length} unasserted calls to ${name}; name each with call("<tag>", ...) and assert it by tag`,
                  );
                }
                call = made[0]!;
              }
              if (!call.expected) {
                return yield* fail(
                  `${name}(${show(call.args)}) is asserted before a call step checks its arguments`,
                );
              }
              const actual = exitJson(call.exit!);
              const expected =
                s.expected._tag === "Success"
                  ? { _tag: "Success", value: normalize(s.expected.value) }
                  : s.expected._tag === "Failure"
                    ? { _tag: "Failure", error: errorJson(s.expected.error) }
                    : { _tag: "Died" };
              const compared = actual._tag === "Died" ? { _tag: "Died" } : actual;
              if (!equal(expected, compared)) {
                return yield* fail(
                  `${name}(${show(call.args)})\n  expected ${show(expected)}\n  actual   ${show(actual)}`,
                );
              }
              observed.splice(observed.indexOf(call), 1);
              break;
            }
          }
        }
        if (unassertedRejection) return yield* rejectionNotAsserted(unassertedRejection);
        const death = platform.control.deaths.find(
          ({ saga, executionId }) => !assertedDeaths.has(`${saga}/${executionId}`),
        );
        if (death) {
          return yield* new StepFailed({
            step: steps.length,
            atEnd: true,
            message: `saga ${death.saga.slice(`${domain.modelName}/`.length)} run ${death.executionId} died with ${String(death.defect)}, which no step asserts`,
          });
        }
        if (observed.length > 0) {
          return yield* new StepFailed({
            step: steps.length,
            atEnd: true,
            message: `real external system calls no step asserts (use returned, failed or died): ${show(observed.map((c) => `${c.system}.${c.op}(${show(c.args)})`))}`,
          });
        }
        if (calls.length > 0) {
          return yield* new StepFailed({
            step: steps.length,
            atEnd: true,
            message: `unanswered external system calls at the end of the story: ${show(calls.map((c) => `${c.system}.${c.op}(${show(c.args)})`))}`,
          });
        }
        attribute(steps.length);
        // Every committed event past its stream's cursor is one no `then` asserts.
        const unasserted: Array<string> = [];
        const streams = new Map<string, Aggregate.Ref>();
        for (const { aggregate, id } of platform.control.commits)
          streams.set(`${aggregate}/${id}`, { aggregate, id } as Aggregate.Ref);
        for (const [stream, ref] of streams) {
          const events = yield* committed(ref);
          const from = cursors.get(stream) ?? 0;
          if (events.length <= from) continue;
          touched.set(stream, ref);
          // Decoded, so redacted fields stay redacted in the message.
          const rest = yield* Effect.forEach(events.slice(from), (e) =>
            internals.kernel.decodeEvent(e.event),
          );
          const first = committedAt.get(`${stream}#${from}`);
          unasserted.push(
            `${stream}: ${summarizeAll(rest)}${first === undefined ? "" : ` (from step ${first})`}`,
          );
        }
        if (unasserted.length > 0) {
          return yield* new StepFailed({
            step: steps.length,
            atEnd: true,
            message: `committed events no step asserts (assert them with then): ${unasserted.join("; ")}`,
            detail: unasserted.join("\n"),
          });
        }
      });

      // Turn a failed step into a failure that shows the whole story.
      const report = (failure: StepFailed) =>
        Effect.gen(function* () {
          const internals = yield* Model.Internals;
          const events: Record<string, ReadonlyArray<string>> = {};
          for (const [name, ref] of touched) {
            const committed =
              internals.aggregates.get(ref.aggregate)!.events?.(ref.id as string) ??
              Effect.succeed([]);
            events[name] = (yield* committed).map(
              (e) => (e.event as { readonly _tag: string })._tag,
            );
          }
          const reports = steps.map((s, index): StepReport => ({
            step: index + 1,
            kind: s._tag,
            status:
              index + 1 < failure.step || (failure.atEnd && index + 1 === failure.step)
                ? "passed"
                : index + 1 === failure.step
                  ? "failed"
                  : "not-run",
            summary: describeStep(s),
          }));
          return yield* new StoryFailure({
            step: failure.step,
            reason: failure.message,
            message: `${failure.message}\n\n${renderReport(failure, reports, events)}`,
            steps: reports,
            events,
          });
        });

      // `hosted` satisfies the Domain, the platform and the stubbed external systems; what
      // remains is whatever the policy Layers need from outside (`LR`'s rest).
      return yield* run.pipe(
        Effect.catchTag("StepFailed", report),
        Effect.provide(
          Layer.mergeAll(hosted, Layer.succeed(ExternalSystem.CallRecorder, recorder)),
        ),
      );
    }) as Effect.Effect<
      void,
      StoryFailure | LE,
      Exclude<LR, Provided | ExternalSystem.Identifier<Systems> | WorkflowEngine.WorkflowEngine>
    >;

/**
 * Given / when / then specifications of a domain model, run against the real
 * model in memory: policies run for real, calls to stubbed external systems
 * wait until you answer them, calls to the others run through their adapters
 * while the story records them, and a clock you control stamps commands and
 * fires scheduled ones. A story fails on any committed event, rejection,
 * external system call or saga defect it doesn't account for.
 *
 * ### Writing a story
 * **Example:** A withdrawal and an overdraft
 * ```typescript
 * import { it } from "@effect/vitest";
 * import { Story } from "@alchemy.run/domain/Story";
 * import { Account, InsufficientFunds, MoneyDeposited, MoneyWithdrawn, WithdrawMoney } from "../src/Account.ts";
 * import { Bank, BankPolicies } from "../src/Bank.ts";
 *
 * const story = Story.make(Bank, { layer: BankPolicies });
 * const account = Account.ref("a-1");
 *
 * it.effect("withdraws within the balance, and refuses beyond it", () =>
 *   story(
 *     Story.given(account, new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
 *     Story.when(account, new WithdrawMoney({ amount: 30 })),
 *     Story.then(account, new MoneyWithdrawn({ amount: 30, balanceAfter: 70 })),
 *     Story.replied({ balance: 70 }),
 *     Story.when(account, new WithdrawMoney({ amount: 100 })),
 *     Story.rejected(new InsufficientFunds({ balance: 70, requested: 100 })),
 *   ),
 * );
 * ```
 *
 * ### External systems and the clock
 * **Example:** Answer an external system call, then move the clock
 * ```typescript
 * Story.call(FraudCheck.score, { accountId: account.id, amount: 60_000 }),
 * Story.succeed(FraudCheck.score, { risk: 0.95 }),
 * Story.clock("2026-01-02T09:00:00Z"),
 * Story.advance("1 day"),
 * ```
 *
 * **Example:** Name calls when several are waiting
 * ```typescript
 * Story.call("a-1", FraudCheck.score, { accountId: a1.id }),
 * Story.call("a-2", FraudCheck.score, { accountId: a2.id }),
 * Story.succeed("a-2", FraudCheck.score, { risk: 0.1 }),
 * Story.succeed("a-1", FraudCheck.score, { risk: 0.95 }),
 * ```
 *
 * **Example:** Assert a real call to a system that is not stubbed
 * ```typescript
 * const story = Story.make(Bank, { layer: BankHandlers, stub: [FraudCheck] });
 *
 * story(
 *   Story.when(account, new RecordSettlement({ settlementId: "st_1", amount: 500 })),
 *   Story.call(Payments.refund, { settlementId: "st_1", amount: 500 }),
 *   Story.returned(Payments.refund, { refundId: "re_st_1" }),
 * ).pipe(Effect.provide(StripePayments));
 * ```
 *
 * **Example:** Fail a call with the operation's declared error, or a defect
 * ```typescript
 * Story.call(LockVendor.deleteCode, { codeId: "pc_1" }),
 * Story.fail(LockVendor.deleteCode, new LockVendorRefused({ reason: "gateway-lost" })),
 * Story.call(LockVendor.deleteCode, { codeId: "pc_2" }),
 * Story.die(LockVendor.deleteCode, new Error("socket closed")),
 * ```
 *
 * ### Sagas
 * **Example:** Check where a saga run is, and send it a signal
 * ```typescript
 * Story.saga(ExecuteTransfer, transfer, { _tag: "Running" }),
 * Story.signal(ExecuteTransfer, transfer, Decision, "approved"),
 * ```
 *
 * @primitive
 */
// The steps live on this object rather than as module exports: a module that
// exports `then` is "thenable", and loaders that await module namespaces
// would hang on it.
export const Story = {
  make,
  given,
  when,
  // oxlint-disable-next-line unicorn/no-thenable -- `then` is the given/when/then vocabulary
  then,
  rejected,
  replied,
  state,
  view,
  emitted,
  streamed,
  call: callStep,
  succeed,
  fail,
  die,
  returned,
  failed,
  died,
  clock,
  advance,
  provide,
  signal,
  saga,
  /** Marker for "the view key does not exist". */
  none,
} as const;

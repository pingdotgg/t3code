import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { DefinitionError, ReservedOperation } from "./DefinitionError.ts";
import type { Fields } from "./Event.ts";
import * as Telemetry from "./Telemetry.ts";

type OpImpl = (args: unknown) => Effect.Effect<unknown, unknown, unknown>;

/**
 * Trace every call to an external system: one client span per call, named
 * after the system and operation, plus a call count by outcome.
 *
 * @internal
 */
export const observeOps = (
  system: string,
  impl: Readonly<Record<string, OpImpl>>,
): Record<string, OpImpl> =>
  Object.fromEntries(
    Object.entries(impl).map(([op, call]) => [
      op,
      (args: unknown) =>
        call(args).pipe(
          Effect.onExit((exit) =>
            Telemetry.record(Telemetry.externalCalls, {
              "domain.system": system,
              "domain.operation": op,
              "domain.outcome": Exit.isSuccess(exit) ? "ok" : "failed",
            }),
          ),
          Effect.withSpan(`Domain.external ${system}.${op}`, {
            kind: "client",
            attributes: { "domain.system": system, "domain.operation": op },
          }),
        ),
    ]),
  );

/**
 * Sees every call to an implemented external system. A story provides one, so
 * it can assert what each real call was sent and what it returned.
 *
 * @internal
 */
export interface CallRecorder {
  readonly record: (
    system: string,
    op: string,
    args: unknown,
    call: Effect.Effect<unknown, unknown, unknown>,
  ) => Effect.Effect<unknown, unknown, unknown>;
}

/** @internal */
export const CallRecorder = Context.Reference<CallRecorder | undefined>(
  "alchemy/Domain/ExternalSystem/CallRecorder",
  { defaultValue: () => undefined },
);

const recordOps = (
  system: string,
  impl: Readonly<Record<string, OpImpl>>,
): Record<string, OpImpl> =>
  Object.fromEntries(
    Object.entries(impl).map(([op, call]) => [
      op,
      Effect.fn(function* (args: unknown) {
        const recorder = yield* CallRecorder;
        return yield* recorder ? recorder.record(system, op, args, call(args)) : call(args);
      }),
    ]),
  );

/**
 * A call to an external system broke its declared schema: the model sent
 * arguments the operation's `args` reject, or the adapter answered with a
 * value or error the operation's `success` or `error` reject. It is a defect,
 * not a business error, because the declaration and the implementation
 * disagree.
 */
export class ExternalSystemSchemaError extends Data.TaggedError("ExternalSystemSchemaError")<{
  readonly system: string;
  readonly op: string;
  /** The side of the call the schema rejected. */
  readonly part: "args" | "success" | "error";
  readonly message: string;
}> {}

const describePart = {
  args: "was called with arguments its schema rejects",
  success: "returned a value its success schema rejects",
  error: "failed with an error its error schema rejects",
} as const;

/** A built check: the value its schema accepts, or an {@link ExternalSystemSchemaError} defect. */
type Check = (value: unknown) => Exit.Exit<unknown>;

/** One operation's built checks. `args` and `success` are absent when it declares none. */
interface OpChecks {
  readonly args: Check | undefined;
  readonly success: Check | undefined;
  readonly error: Check;
}

const makeCheck = (
  system: string,
  op: string,
  part: keyof typeof describePart,
  schema: Schema.Top,
): Check => {
  // Only the type side: it validates values and never re-runs a transformation.
  const decode = Schema.decodeUnknownExit(Schema.toType(schema) as Schema.Decoder<unknown>) as (
    value: unknown,
  ) => Exit.Exit<unknown, Schema.SchemaError>;
  return (value) => {
    const exit = decode(value);
    if (Exit.isSuccess(exit)) return Exit.succeed(exit.value);
    const found = Cause.findError(exit.cause);
    return Exit.die(
      found._tag === "Success"
        ? new ExternalSystemSchemaError({
            system,
            op,
            part,
            message: `${system}.${op} ${describePart[part]}\n${found.success.message}`,
          })
        : // A defect inside the schema passes through.
          Cause.squash(exit.cause),
    );
  };
};

/**
 * Build the checks for every operation of a system, once: its arguments, its
 * success value and its typed error.
 *
 * @internal
 */
export const compileChecks = (
  system: string,
  ops: Readonly<Record<string, OpSpec>>,
): Effect.Effect<Readonly<Record<string, OpChecks>>> =>
  Effect.sync(() =>
    Object.fromEntries(
      Object.entries(ops).map(([op, spec]) => [
        op,
        {
          args:
            spec.args === undefined
              ? undefined
              : makeCheck(system, op, "args", Schema.Struct(spec.args)),
          success:
            spec.success === undefined
              ? undefined
              : makeCheck(system, op, "success", successSchema(spec)),
          error: makeCheck(system, op, "error", errorSchema(spec)),
        } satisfies OpChecks,
      ]),
    ),
  );

/**
 * Check every call against its operation's built checks: the arguments before
 * the implementation runs, and its success value or typed error after. A value
 * a schema rejects becomes an {@link ExternalSystemSchemaError} defect. Defects
 * pass through.
 *
 * @internal
 */
export const validateOps = (
  checks: Readonly<Record<string, OpChecks>>,
  impl: Readonly<Record<string, OpImpl>>,
): Record<string, OpImpl> =>
  Object.fromEntries(
    Object.entries(impl).map(([op, call]): [string, OpImpl] => {
      const check = checks[op];
      if (check === undefined) return [op, call];
      const { args, success, error } = check;
      const checked: OpImpl = (input) =>
        Effect.matchEffect(args ? Effect.flatMap(args(input), call) : call(input), {
          onSuccess: success ?? Effect.succeed,
          onFailure: (failure) => Effect.flatMap(error(failure), Effect.fail),
        });
      return [op, checked];
    }),
  );

/**
 * Options for {@link ExternalSystemClass.toLayer}.
 */
export interface ToLayerOptions {
  /**
   * Check every call against the operation's schemas. Defaults to `true`.
   * Turn it off only when the check costs too much, for example on a large
   * payload an adapter already validates.
   */
  readonly validate?: boolean;
}

/**
 * One operation of an external system: its arguments, success value and business errors.
 * `error` is one schema, or a list of them when the vendor can refuse in several ways.
 */
export interface OpSpec {
  readonly args?: Fields;
  readonly success?: Fields | Schema.Top;
  readonly error?: Schema.Top | ReadonlyArray<Schema.Top>;
}

type ArgsOf<S extends OpSpec> = S["args"] extends Fields ? Schema.Struct<S["args"]>["Type"] : void;
type SuccessOf<S extends OpSpec> = S["success"] extends Schema.Top
  ? S["success"]["Type"]
  : S["success"] extends Fields
    ? Schema.Struct<S["success"]>["Type"]
    : void;
type ErrorOf<S extends OpSpec> =
  S["error"] extends ReadonlyArray<Schema.Top>
    ? S["error"][number]["Type"]
    : S["error"] extends Schema.Top
      ? S["error"]["Type"]
      : never;

/**
 * The service shape of an external system: one Effect-returning function per operation.
 */
export type Shape<Ops extends Record<string, OpSpec>> = {
  readonly [K in keyof Ops]: (
    args: ArgsOf<Ops[K]>,
  ) => Effect.Effect<SuccessOf<Ops[K]>, ErrorOf<Ops[K]>>;
};

/**
 * A reference to one external system operation, used by stories (`call`, `succeed`, `fail`).
 */
export interface Op<Args = unknown, Success = unknown, Error = unknown> {
  readonly kind: "ExternalSystemOp";
  readonly system: string;
  readonly op: string;
  readonly "~args"?: Args;
  readonly "~success"?: Success;
  readonly "~error"?: Error;
}

/**
 * Structural constraint satisfied by every external system class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "ExternalSystem";
  readonly systemName: string;
  readonly ops: Record<string, OpSpec>;
}

/** The requirement identifier of an external system class. */
export type Identifier<P extends Any> = P extends Context.Key<infer I, unknown> ? I : never;

/**
 * Type-level identity of an external system in an Effect's requirements.
 */
export interface ExternalSystemKey<Name extends string> {
  readonly "~alchemy/Domain/ExternalSystem": Name;
}

const RESERVED = [
  "name",
  "length",
  "prototype",
  "kind",
  "systemName",
  "ops",
  "toLayer",
  "key",
] as const;
type Reserved = (typeof RESERVED)[number];
const reserved = new Set<string>(RESERVED);

/**
 * An outside system your model calls, such as a payment provider or a fraud
 * scorer, declared as the operations the model uses. It's an Effect service:
 * policies `yield*` it, an adapter implements it with `toLayer`, and stories
 * answer its calls themselves, so the model depends on what it asks for and
 * never on a vendor.
 *
 * ### Declaring an external system and an adapter
 * **Example:** A fraud scorer
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Effect from "effect/Effect";
 * import * as Schema from "effect/Schema";
 *
 * export class FraudCheck extends Domain.ExternalSystem("FraudCheck", {
 *   score: { args: { accountId: Schema.String, amount: Schema.Int }, success: { risk: Schema.Number } },
 * }) {}
 *
 * export const SiftFraudCheck = FraudCheck.toLayer(
 *   Effect.succeed({
 *     score: ({ amount }) => Effect.succeed({ risk: amount >= 80_000 ? 0.95 : 0.05 }),
 *   }),
 * );
 * ```
 *
 * @primitive
 */
export const make = <const Name extends string, const Ops extends Record<string, OpSpec>>(
  name: Name,
  // An operation named after a static of the class would replace it.
  ops: Ops & { readonly [K in Extract<keyof Ops, Reserved>]: never },
): ExternalSystemClass<Name, Ops> => {
  const Tag = Context.Service<ExternalSystemKey<Name>, Shape<Ops>>()(
    `alchemy/Domain/ExternalSystem/${name}`,
  );
  const cls = class extends Tag {
    static readonly kind = "ExternalSystem" as const;
    static readonly systemName: Name = name;
    static readonly ops: Ops = ops;
    /** Implement the external system with an Effect that builds its service. */
    static toLayer<E, R>(
      build: Effect.Effect<Shape<Ops>, E, R>,
      options?: ToLayerOptions,
    ): Layer.Layer<ExternalSystemKey<Name>, E, R> {
      return Layer.effect(
        Tag,
        Effect.gen(function* () {
          const clash = Object.keys(ops).find((op) => reserved.has(op));
          if (clash !== undefined) {
            return yield* Effect.die(
              new DefinitionError({
                reason: new ReservedOperation({ system: name, operation: clash }),
              }),
            );
          }
          const checks = options?.validate === false ? undefined : yield* compileChecks(name, ops);
          const impl = (yield* build) as Record<string, OpImpl>;
          const checked = checks === undefined ? impl : validateOps(checks, impl);
          return observeOps(name, recordOps(name, checked)) as never;
        }),
      );
    }
  };
  for (const op of Object.keys(ops)) {
    // The signature rejects a reserved name; toLayer dies if one gets through.
    if (reserved.has(op)) continue;
    // oxlint-disable-next-line effecttsgo/floating-effect -- returns `cls`, which is Effect-able; nothing to run
    Object.defineProperty(cls, op, {
      value: { kind: "ExternalSystemOp", system: name, op } satisfies Op,
      enumerable: true,
    });
  }
  return cls as unknown as ExternalSystemClass<Name, Ops>;
};

/**
 * The class type returned by {@link make}.
 */
export type ExternalSystemClass<
  Name extends string,
  Ops extends Record<string, OpSpec>,
> = Context.ServiceClass<ExternalSystemKey<Name>, string, Shape<Ops>> & {
  readonly kind: "ExternalSystem";
  readonly systemName: Name;
  readonly ops: Ops;
  /**
   * Implement the external system with an Effect that builds its service.
   * Every call is checked against the operation's schemas unless
   * `validate: false`.
   */
  toLayer<E, R>(
    build: Effect.Effect<Shape<Ops>, E, R>,
    options?: ToLayerOptions,
  ): Layer.Layer<ExternalSystemKey<Name>, E, R>;
} & {
  readonly [K in keyof Ops]: Op<ArgsOf<Ops[K]>, SuccessOf<Ops[K]>, ErrorOf<Ops[K]>>;
};

/** @internal */
export const successSchema = (spec: OpSpec): Schema.Top =>
  spec.success === undefined
    ? Schema.Void
    : "ast" in (spec.success as object)
      ? (spec.success as Schema.Top)
      : Schema.Struct(spec.success as Fields);

/**
 * The schema of an operation's declared `error`: the schema itself, a
 * `Schema.Union` of a list, or `Schema.Never` when it declares none.
 *
 * @internal
 */
export const errorSchema = (spec: OpSpec): Schema.Top =>
  spec.error === undefined
    ? Schema.Never
    : Array.isArray(spec.error)
      ? Schema.Union(spec.error as ReadonlyArray<Schema.Top>)
      : (spec.error as Schema.Top);

import * as NodeUtil from "node:util";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { flow } from "effect/Function";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Output from "../Output.ts";
import { isRedactedMarker, type RedactedMarker } from "../RuntimeContext.ts";
import { decodeDuration, DURATION_MARKER, encodeState } from "../State/StateEncoding.ts";
import {
  currentTraceParent,
  type TraceParent,
  withStreamTraceParent,
  withTraceParent,
} from "../Util/TraceParent.ts";

type RpcEffectHandler<Args extends Array<any>, Success, Error> = (
  ...args: Args
) => Effect.Effect<Success, Error>;

// `parent`: the caller's span, so the sidecar's work joins its trace.
type RpcWrappedEffectHandler<Args extends Array<any>, Success, Error> = (
  args: Args,
  parent?: TraceParent,
) => Promise<RpcSerializedExit<Success, Error>>;

type RpcStreamHandler<Args extends Array<any>, Success, Error> = (
  ...args: Args
) => Stream.Stream<Success, Error>;

type RpcWrappedStreamHandler<Args extends Array<any>, Success, Error> = (
  args: Args,
  parent?: TraceParent,
) => RpcSerializedStream<Success, Error>;

type RpcSerializedStream<Success, _Error> = ReadableStream<Success>;

type RpcSerializedExit<Success, Error> =
  | { _tag: "Success"; value: Success }
  | { _tag: "Failure"; cause: Array<RpcSerializedCause<Error>> };

type RpcSerializedCause<Error> =
  | { _tag: "Fail"; error: Error }
  | { _tag: "Die"; defect: unknown }
  | { _tag: "Interrupt"; fiberId: number | undefined };

export type RpcWrapped<T> =
  T extends RpcEffectHandler<infer Args, infer Success, infer Error>
    ? RpcWrappedEffectHandler<Args, Success, Error>
    : T extends RpcStreamHandler<infer Args, infer Success, infer Error>
      ? RpcWrappedStreamHandler<Args, Success, Error>
      : T extends Record<string, any>
        ? { [K in keyof T]: RpcWrapped<T[K]> }
        : T;

export type RpcUnwrapped<T> =
  T extends RpcWrappedEffectHandler<infer Args, infer Success, infer Error>
    ? RpcEffectHandler<Args, Success, Error>
    : T extends RpcWrappedStreamHandler<infer Args, infer Success, infer Error>
      ? RpcStreamHandler<Args, Success, Error>
      : T extends Record<string, any>
        ? { [K in keyof T]: RpcUnwrapped<T[K]> }
        : T;

export const wrapRpcHandlers = <T extends Record<string, any>>(
  handlers: T,
  streamKeys?: Array<keyof T>,
  registerCall?: Effect.Effect<void, never, Scope.Scope>,
): RpcWrapped<T> =>
  Object.fromEntries(
    Object.entries(handlers).map(([key, value]) => [
      key,
      typeof value === "function"
        ? streamKeys?.includes(key)
          ? wrapRpcStreamHandler(value, registerCall)
          : wrapRpcEffectHandler(value, registerCall)
        : typeof value === "object" && value !== null && !Array.isArray(value)
          ? wrapRpcHandlers(value, undefined, registerCall)
          : value,
    ]),
  ) as RpcWrapped<T>;

export const unwrapRpcHandlers = <T extends Record<string, any>>(
  handlers: RpcWrapped<T>,
  streamKeys?: Array<keyof T>,
): RpcUnwrapped<T> =>
  Object.fromEntries(
    Object.entries(handlers).map(([key, value]) => [
      key,
      typeof value === "function"
        ? streamKeys?.includes(key)
          ? unwrapRpcStreamHandler(value)
          : unwrapRpcEffectHandler(value)
        : typeof value === "object" && value !== null && !Array.isArray(value)
          ? unwrapRpcHandlers(value)
          : value,
    ]),
  ) as RpcUnwrapped<T>;

const serializeError = (value: unknown) =>
  Schema.encodeEffect(Schema.Defect())(value).pipe(Effect.orDie);

/** Wire form of a tagged failure: its tag plus every field the error carries. */
interface TaggedErrorMarker {
  readonly _tag: "~alchemy/Rpc/TaggedError";
  readonly tag: string;
  readonly name: string | undefined;
  readonly message: string | undefined;
  readonly stack: string | undefined;
  readonly fields: Record<string, unknown>;
}

const taggedErrorClasses = new Map<string, new (...args: any) => object>();

/**
 * Registers tagged error classes that a provider may fail with across the RPC
 * sidecar boundary, so the caller receives instances of the real class (for
 * `instanceof`) rather than plain tagged objects. Registration is by `_tag`;
 * call it next to the class definitions so both processes register them.
 */
export const registerRpcErrorClasses = (
  ...classes: ReadonlyArray<new (...args: any) => { readonly _tag: string }>
): void => {
  for (const cls of classes) {
    // `Data.TaggedError` sets `_tag` per instance, so read it from a probe.
    const probe = Reflect.construct(cls, [{}]) as { readonly _tag: string };
    taggedErrorClasses.set(probe._tag, cls);
  }
};

const hasStringTag = (value: unknown): value is { readonly _tag: string } =>
  typeof value === "object" && value !== null && "_tag" in value && typeof value._tag === "string";

const serializeFailure = (error: unknown): Effect.Effect<unknown> => {
  // Keep a tagged failure's tag and fields so the caller can still
  // `catchTag` on it (Schema.Defect alone reduces it to name + message).
  if (!hasStringTag(error)) return serializeError(error);
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (key === "_tag") continue;
    fields[key] = serializeRpcArgs(value);
  }
  const asError = error instanceof Error ? error : undefined;
  return Effect.succeed({
    _tag: "~alchemy/Rpc/TaggedError",
    tag: error._tag,
    name: asError?.name,
    message: asError?.message,
    stack: asError?.stack,
    fields,
  } satisfies TaggedErrorMarker);
};

const isTaggedErrorMarker = (value: unknown): value is TaggedErrorMarker =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "~alchemy/Rpc/TaggedError" &&
  "tag" in value &&
  typeof value.tag === "string";

const deserializeFailure = (error: unknown): unknown => {
  if (!isTaggedErrorMarker(error)) return error;
  const fields = deserializeRpcArgs(error.fields) as Record<string, unknown>;
  const cls = taggedErrorClasses.get(error.tag);
  const revived: Record<string, unknown> =
    cls === undefined
      ? error.message === undefined
        ? {}
        : (new Error(error.message) as unknown as Record<string, unknown>)
      : (Object.create(cls.prototype) as Record<string, unknown>);
  Object.assign(revived, fields);
  revived._tag = error.tag;
  for (const key of ["name", "message", "stack"] as const) {
    const value = error[key];
    if (value !== undefined && !(key in fields)) {
      Object.defineProperty(revived, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }
  return revived;
};

const wrapRpcEffectHandler = <Args extends Array<any>, Success, Error>(
  handler: RpcEffectHandler<Args, Success, Error>,
  registerCall?: Effect.Effect<void, never, Scope.Scope>,
): RpcWrappedEffectHandler<Args, Success, Error> =>
  flow(
    (args, parent) => {
      const call = Effect.suspend(() => handler(...(deserializeRpcArgs(args) as Args)));
      return (
        registerCall === undefined ? call : Effect.scoped(registerCall.pipe(Effect.andThen(call)))
      ).pipe(withTraceParent(parent));
    },
    Effect.exit,
    Effect.flatMap((exit): Effect.Effect<RpcSerializedExit<Success, Error>> => {
      if (exit._tag === "Success") {
        // Success values need the same marker treatment as args: provider
        // attributes can legitimately carry `Redacted` secrets (e.g. a local
        // container's bound env), and a raw Redacted reaching capnweb dies
        // with `TypeError: Cannot serialize value: <redacted>`.
        return Effect.succeed({
          _tag: "Success",
          value: serializeRpcArgs(exit.value) as Success,
        });
      }
      return Effect.forEach(
        exit.cause.reasons,
        (reason): Effect.Effect<RpcSerializedCause<Error>> => {
          switch (reason._tag) {
            case "Fail":
              return serializeFailure(reason.error).pipe(
                Effect.map((error) => ({ _tag: "Fail", error: error as Error })),
              );
            case "Die":
              return serializeError(reason.defect).pipe(
                Effect.map((defect) => ({ _tag: "Die", defect })),
              );
            case "Interrupt":
              return Effect.succeed({ _tag: "Interrupt", fiberId: reason.fiberId });
          }
        },
      ).pipe(Effect.map((cause) => ({ _tag: "Failure", cause })));
    }),
    Effect.runPromise,
  );

const wrapRpcStreamHandler = <Args extends Array<any>, Success, Error>(
  handler: RpcStreamHandler<Args, Success, Error>,
  registerCall?: Effect.Effect<void, never, Scope.Scope>,
): RpcWrappedStreamHandler<Args, Success, Error> =>
  flow(
    (args, parent) => {
      const call = Effect.sync(() => handler(...(deserializeRpcArgs(args) as Args)));
      return Stream.unwrap(
        registerCall === undefined ? call : registerCall.pipe(Effect.andThen(call)),
      ).pipe(withStreamTraceParent(parent));
    },
    (stream) => Stream.toReadableStream(stream),
  );

const unwrapRpcEffectHandler = <Args extends Array<any>, Success, Error>(
  handler: RpcWrappedEffectHandler<Args, Success, Error>,
): RpcEffectHandler<Args, Success, Error> =>
  flow(
    (...args) => serializeRpcArgs(args) as Args,
    (args) =>
      Effect.flatMap(currentTraceParent, (parent) => Effect.promise(() => handler(args, parent))),
    Effect.flatMap((exit): Exit.Exit<Success, Error> => {
      if (exit._tag === "Success") {
        // Mirror of the wrap side: rebuild `Redacted` wrappers from their
        // wire markers so callers get the same shape an in-process provider
        // returns.
        return Exit.succeed(deserializeRpcArgs(exit.value) as Success);
      }
      return Exit.failCause(
        Cause.fromReasons(
          exit.cause.map((reason): Cause.Reason<Error> => {
            switch (reason._tag) {
              case "Fail":
                return Cause.makeFailReason(deserializeFailure(reason.error) as Error);
              case "Die":
                return Cause.makeDieReason(reason.defect);
              case "Interrupt":
                return Cause.makeInterruptReason(reason.fiberId);
            }
          }),
        ),
      );
    }),
  );

const unwrapRpcStreamHandler = <Args extends Array<any>, Success, Error>(
  handler: RpcWrappedStreamHandler<Args, Success, Error>,
): RpcStreamHandler<Args, Success, Error> =>
  flow(
    (...args) => serializeRpcArgs(args) as Args,
    (args) =>
      Stream.unwrap(
        Effect.map(currentTraceParent, (parent) =>
          Stream.fromReadableStream({
            evaluate: () => handler(args, parent),
            onError: (error) => error as Error,
          }),
        ),
      ),
  );

const serializeRpcArgs = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) {
    return {
      _tag: "Redacted",
      value: Redacted.value(value),
    } satisfies RedactedMarker;
  }
  // Output must be tested BEFORE Effect.isEffect — Output exprs are yieldable
  // and would otherwise be misclassified as plain Effects.
  if (Output.isOutput(value)) {
    return {
      _tag: "Output",
      description: NodeUtil.inspect(value),
    };
  }
  // Runtime-only effect values riding in props (e.g. a Worker's `exports`
  // carries each DO's `constructor` Effect and captured `services` Context —
  // passed through prop resolution by identity since #1094). They cannot
  // cross the wire (function-valued internals kill capnweb) and the sidecar
  // never runs them (`stripEffects` drops them from `news` provider-side), so
  // ship a marker that deserializes back into an equivalent leaf: an Effect
  // that dies loudly if it IS ever run, keeping `isResolved`/`stripEffects`
  // semantics identical on both sides of the boundary.
  if (Effect.isEffect(value)) {
    return {
      _tag: "~alchemy/Rpc/Effect",
      description: NodeUtil.inspect(value),
    } satisfies EffectMarker;
  }
  if (Context.isContext(value)) {
    return {
      _tag: "~alchemy/Rpc/Context",
      description: NodeUtil.inspect(value),
    } satisfies ContextMarker;
  }
  // Duration has `toJSON` (so the structural walk below skips it) but
  // capnweb cannot serialize the live Effect Duration object — it dies
  // with `TypeError: Cannot serialize value: 15000 millis`. Use the same
  // `{ __duration__: toJSON() }` envelope as persisted state.
  if (Duration.isDuration(value)) {
    return encodeState(value);
  }
  if (typeof value === "function") {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(serializeRpcArgs);
  }
  if (value && typeof value === "object" && !("toJSON" in value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, serializeRpcArgs(child)]),
    );
  }
  return value;
};

interface EffectMarker {
  readonly _tag: "~alchemy/Rpc/Effect";
  readonly description: string;
}

interface ContextMarker {
  readonly _tag: "~alchemy/Rpc/Context";
  readonly description: string;
}

const isEffectMarker = (value: object): value is EffectMarker =>
  "_tag" in value &&
  value._tag === "~alchemy/Rpc/Effect" &&
  "description" in value &&
  typeof value.description === "string";

const isContextMarker = (value: object): value is ContextMarker =>
  "_tag" in value &&
  value._tag === "~alchemy/Rpc/Context" &&
  "description" in value &&
  typeof value.description === "string";

const isDurationEnvelope = (value: object): value is { [DURATION_MARKER]: unknown } =>
  DURATION_MARKER in value && Object.keys(value).length === 1;

const deserializeRpcArgs = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(deserializeRpcArgs);
  } else if (typeof value === "object" && value !== null) {
    // These values are serialized as `{_tag: "Redacted", value: ...}` and `{_tag: "Output", description: ...}`,
    // so we need to detect them manually - Redacted.isRedacted and Output.isOutput do not work.
    if (isRedactedMarker(value)) {
      return Redacted.make(value.value);
    } else if (
      "_tag" in value &&
      value._tag === "Output" &&
      "description" in value &&
      typeof value.description === "string"
    ) {
      return new Output.NamedExpr(
        new Output.EffectExpr(Output.VoidExpr, () => Effect.never),
        value.description,
      );
    } else if (isEffectMarker(value)) {
      // Rebuild an Effect-typed leaf so `isResolved`/`stripEffects` classify
      // it exactly like the original; dies loudly if anything ever runs it.
      const description = value.description;
      return Effect.suspend(() =>
        Effect.die(
          new Error(
            `An Effect from the resource's props cannot cross the RPC provider boundary and was replaced by a placeholder: ${description}`,
          ),
        ),
      );
    } else if (isContextMarker(value)) {
      return Context.empty();
    } else if (isDurationEnvelope(value)) {
      return decodeDuration(value[DURATION_MARKER]) ?? value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, deserializeRpcArgs(child)]),
    );
  }
  return value;
};

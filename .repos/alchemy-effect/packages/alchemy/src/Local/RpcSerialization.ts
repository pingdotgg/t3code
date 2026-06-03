import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { flow } from "effect/Function";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeUtil from "node:util";
import * as Output from "../Output.ts";

type RpcEffectHandler<Args extends Array<any>, Success, Error> = (
  ...args: Args
) => Effect.Effect<Success, Error>;

type RpcWrappedEffectHandler<Args extends Array<any>, Success, Error> = (
  args: Args,
) => Promise<RpcSerializedExit<Success, Error>>;

type RpcStreamHandler<Args extends Array<any>, Success, Error> = (
  ...args: Args
) => Stream.Stream<Success, Error>;

type RpcWrappedStreamHandler<Args extends Array<any>, Success, Error> = (
  args: Args,
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
): RpcWrapped<T> => {
  return Object.fromEntries(
    Object.entries(handlers).map(([key, value]) => [
      key,
      typeof value === "function"
        ? streamKeys?.includes(key)
          ? wrapRpcStreamHandler(value)
          : wrapRpcEffectHandler(value)
        : typeof value === "object" && value !== null
          ? wrapRpcHandlers(value)
          : value,
    ]),
  ) as RpcWrapped<T>;
};

export const unwrapRpcHandlers = <T extends Record<string, any>>(
  handlers: RpcWrapped<T>,
  streamKeys?: Array<keyof T>,
): RpcUnwrapped<T> => {
  return Object.fromEntries(
    Object.entries(handlers).map(([key, value]) => [
      key,
      typeof value === "function"
        ? streamKeys?.includes(key)
          ? unwrapRpcStreamHandler(value)
          : unwrapRpcEffectHandler(value)
        : typeof value === "object" && value !== null
          ? unwrapRpcHandlers(value)
          : value,
    ]),
  ) as RpcUnwrapped<T>;
};

const serializeError = Schema.encodeSync(Schema.Defect);

const wrapRpcEffectHandler = <Args extends Array<any>, Success, Error>(
  handler: RpcEffectHandler<Args, Success, Error>,
): RpcWrappedEffectHandler<Args, Success, Error> =>
  flow(
    (args) => deserializeRpcArgs(args) as Args,
    (args) => handler(...args),
    Effect.exit,
    Effect.map((exit): RpcSerializedExit<Success, Error> => {
      if (exit._tag === "Success") {
        return { _tag: "Success", value: exit.value };
      }
      return {
        _tag: "Failure",
        cause: exit.cause.reasons.map((reason): RpcSerializedCause<Error> => {
          switch (reason._tag) {
            case "Fail":
              return { _tag: "Fail", error: serializeError(reason.error) };
            case "Die":
              return { _tag: "Die", defect: serializeError(reason.defect) };
            case "Interrupt":
              return { _tag: "Interrupt", fiberId: reason.fiberId };
          }
        }),
      };
    }),
    Effect.runPromise,
  );

const wrapRpcStreamHandler = <Args extends Array<any>, Success, Error>(
  handler: RpcStreamHandler<Args, Success, Error>,
): RpcWrappedStreamHandler<Args, Success, Error> =>
  flow(
    (args) => deserializeRpcArgs(args) as Args,
    (args) => handler(...args),
    (stream) => Stream.toReadableStream(stream),
  );

const unwrapRpcEffectHandler = <Args extends Array<any>, Success, Error>(
  handler: RpcWrappedEffectHandler<Args, Success, Error>,
): RpcEffectHandler<Args, Success, Error> =>
  flow(
    (...args) => serializeRpcArgs(args) as Args,
    (args) => Effect.promise(() => handler(args)),
    Effect.flatMap((exit): Exit.Exit<Success, Error> => {
      if (exit._tag === "Success") {
        return Exit.succeed(exit.value);
      }
      return Exit.failCause(
        Cause.fromReasons(
          exit.cause.map((reason): Cause.Reason<Error> => {
            switch (reason._tag) {
              case "Fail":
                return Cause.makeFailReason(reason.error);
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
    (args) => handler(args),
    (stream) =>
      Stream.fromReadableStream({
        evaluate: () => stream,
        onError: (error) => error as Error,
      }),
  );

const serializeRpcArgs = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) {
    return { _tag: "Redacted", value: Redacted.value(value) };
  }
  if (Output.isOutput(value)) {
    return {
      _tag: "Output",
      description: NodeUtil.inspect(value),
    };
  }
  if (typeof value === "function") {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(serializeRpcArgs);
  }
  if (value && typeof value === "object" && !("toJSON" in value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        serializeRpcArgs(child),
      ]),
    );
  }
  return value;
};

const deserializeRpcArgs = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(deserializeRpcArgs);
  } else if (typeof value === "object" && value !== null) {
    // These values are serialized as `{_tag: "Redacted", value: ...}` and `{_tag: "Output", description: ...}`,
    // so we need to detect them manually - Redacted.isRedacted and Output.isOutput do not work.
    if ("_tag" in value && value._tag === "Redacted" && "value" in value) {
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
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        deserializeRpcArgs(child),
      ]),
    );
  }
  return value;
};

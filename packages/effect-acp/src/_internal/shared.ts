import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { RpcClientError } from "effect/unstable/rpc";

import * as AcpSchema from "../_generated/schema.gen.ts";
import * as AcpError from "../errors.ts";
const isError = Schema.is(AcpSchema.Error);

/** Default control-plane RPC timeout (matches protocol.DEFAULT_CONTROL_PLANE_REQUEST_TIMEOUT). */
const DEFAULT_CONTROL_PLANE_REQUEST_TIMEOUT = Duration.seconds(60);

export type CallRpcTimeout = Duration.Input | "none";

export const callRpc = <A>(
  method: string,
  effect: Effect.Effect<A, RpcClientError.RpcClientError | AcpSchema.Error>,
  options?: { readonly timeout?: CallRpcTimeout },
): Effect.Effect<A, AcpError.AcpError> => {
  const mapped = effect.pipe(
    Effect.catchIf(isError, (error) =>
      Effect.fail(AcpError.AcpRequestError.fromProtocolError(error, { method })),
    ),
    Effect.catchTags({
      RpcClientError: (cause) =>
        Effect.fail(
          new AcpError.AcpTransportError({
            operation: "call-rpc",
            method,
            cause,
          }),
        ),
    }),
  );

  const timeoutOpt = options?.timeout;
  if (timeoutOpt === "none") {
    return mapped;
  }
  const timeoutDuration =
    timeoutOpt === undefined ? DEFAULT_CONTROL_PLANE_REQUEST_TIMEOUT : timeoutOpt;
  const timeoutMs = Duration.toMillis(Duration.fromInputUnsafe(timeoutDuration));
  if (timeoutMs <= 0) {
    return mapped;
  }

  return mapped.pipe(
    Effect.timeoutOption(timeoutDuration),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(
            new AcpError.AcpRequestTimeoutError({
              method,
              timeoutMs,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
};

export const runHandler = Effect.fnUntraced(function* <A, B>(
  handler: ((payload: A) => Effect.Effect<B, AcpError.AcpError>) | undefined,
  payload: A,
  method: string,
) {
  if (!handler) {
    return yield* Effect.fail(AcpError.AcpRequestError.methodNotFound(method).toProtocolError());
  }
  return yield* handler(payload).pipe(
    Effect.mapError((error) =>
      AcpError.AcpRequestError.fromCoreHandlerError(error, method).toProtocolError(),
    ),
  );
});

export function decodeExtRequestRegistration<A, I>(
  method: string,
  payload: Schema.Codec<A, I>,
  handler: (payload: A) => Effect.Effect<unknown, AcpError.AcpError>,
) {
  return (params: unknown): Effect.Effect<unknown, AcpError.AcpError> =>
    Schema.decodeUnknownEffect(payload)(params).pipe(
      Effect.mapError((error) => AcpError.AcpRequestError.invalidExtensionPayload(method, error)),
      Effect.flatMap((decoded) => handler(decoded)),
    );
}

export function decodeExtNotificationRegistration<A, I>(
  method: string,
  payload: Schema.Codec<A, I>,
  handler: (payload: A) => Effect.Effect<void, AcpError.AcpError>,
) {
  return (params: unknown): Effect.Effect<void, AcpError.AcpError> =>
    Schema.decodeUnknownEffect(payload)(params).pipe(
      Effect.mapError((error) =>
        AcpError.AcpProtocolParseError.fromSchemaError(
          "decode-notification-payload",
          method,
          error,
        ),
      ),
      Effect.flatMap((decoded) => handler(decoded)),
    );
}

const encoder = new TextEncoder();

const JsonRpcId = Schema.Union([Schema.Number, Schema.String]);
const JsonRpcHeaders = Schema.Array(Schema.Unknown);

export const jsonRpcRequest = <A, I>(method: string, params: Schema.Codec<A, I>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: JsonRpcId,
    method: Schema.Literal(method),
    params,
    headers: JsonRpcHeaders,
  });

export const jsonRpcNotification = <A, I>(method: string, params: Schema.Codec<A, I>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    method: Schema.Literal(method),
    params,
  });

export const jsonRpcResponse = <A, I>(result: Schema.Codec<A, I>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: JsonRpcId,
    result,
  });

export const encodeJsonl = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Effect.map(Schema.encodeEffect(Schema.fromJsonString(schema))(value), (encoded) =>
    encoder.encode(`${encoded}\n`),
  );

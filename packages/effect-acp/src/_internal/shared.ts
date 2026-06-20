import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RpcClientError } from "effect/unstable/rpc";

import * as AcpSchema from "../_generated/schema.gen.ts";
import * as AcpError from "../errors.ts";
const isError = Schema.is(AcpSchema.Error);

export const callRpc = <A>(
  method: string,
  effect: Effect.Effect<A, RpcClientError.RpcClientError | AcpSchema.Error>,
): Effect.Effect<A, AcpError.AcpError> =>
  effect.pipe(
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

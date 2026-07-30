import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

export const API = RpcGroup.make(
  Rpc.make("Ping", {
    payload: Schema.Void,
    success: Schema.String,
  }),
  Rpc.make("Stream", {
    payload: { upto: Schema.Number },
    success: RpcSchema.Stream(Schema.Number, Schema.Never),
  }),
);

const httpEffect = RpcServer.toHttpEffect(API).pipe(
  Effect.provide(
    Layer.mergeAll(
      API.toLayer({
        Ping: () => Effect.succeed("pong"),
        Stream: ({ upto }) =>
          Stream.fromIterable(Array.from({ length: upto }, (_, i) => i)),
      }),
      RpcSerialization.layerNdjson,
    ),
  ),
);

export default {
  fetch(request: Request) {
    return httpEffect.pipe(
      Effect.flatMap((eff) => eff),
      Effect.provide([
        Layer.succeed(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request as any).modify({
            remoteAddress: Option.fromUndefinedOr(
              request.headers.get("cf-connecting-ip") ?? undefined,
            ),
          }),
        ),
        FetchHttpClient.layer,
      ]),
      Effect.flatMap((response) =>
        Effect.context().pipe(
          Effect.map((context) =>
            HttpServerResponse.toWeb(response as any, {
              context,
            }),
          ),
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    );
  },
};

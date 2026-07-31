import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class HttpResponseCompression extends Context.Service<
  HttpResponseCompression,
  {
    readonly gzip: (
      body: Uint8Array,
      options: HttpServerResponse.Options,
    ) => HttpServerResponse.HttpServerResponse;
  }
>()("t3/httpCompression/HttpResponseCompression") {}

export const layerNode = Layer.effect(
  HttpResponseCompression,
  Effect.gen(function* () {
    const NodeZlib = yield* Effect.promise(() => import("node:zlib"));
    return {
      gzip: (body, options) => {
        const stream = NodeZlib.createGzip();
        stream.end(body);
        return HttpServerResponse.raw(stream, options);
      },
    };
  }),
);

export const layerBun = Layer.succeed(HttpResponseCompression, {
  gzip: (body, options) =>
    HttpServerResponse.raw(
      new Response(body).body!.pipeThrough(new CompressionStream("gzip")),
      options,
    ),
});

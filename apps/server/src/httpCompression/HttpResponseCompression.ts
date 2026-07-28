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
    const [NodeStream, NodeZlib] = yield* Effect.all([
      Effect.promise(() => import("node:stream")),
      Effect.promise(() => import("node:zlib")),
    ]);
    return HttpResponseCompression.of({
      gzip: (body, options) =>
        HttpServerResponse.raw(
          NodeStream.Readable.from([body]).pipe(NodeZlib.createGzip()),
          options,
        ),
    });
  }),
);

export const layerBun = Layer.succeed(
  HttpResponseCompression,
  HttpResponseCompression.of({
    gzip: (body, options) =>
      HttpServerResponse.raw(
        new Response(body).body!.pipeThrough(new CompressionStream("gzip")),
        options,
      ),
  }),
);

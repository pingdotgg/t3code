import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { HttpResponseCompression } from "./HttpResponseCompression.ts";

export const make = HttpResponseCompression.of({
  gzip: (body, options) =>
    HttpServerResponse.raw(
      new Response(body).body!.pipeThrough(new CompressionStream("gzip")),
      options,
    ),
});

export const layer = Layer.succeed(HttpResponseCompression, make);

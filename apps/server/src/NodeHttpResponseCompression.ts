import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { HttpResponseCompression } from "./HttpResponseCompression.ts";

export const make = HttpResponseCompression.of({
  gzip: (body, options) =>
    HttpServerResponse.raw(NodeStream.Readable.from([body]).pipe(NodeZlib.createGzip()), options),
});

export const layer = Layer.succeed(HttpResponseCompression, make);

import * as Context from "effect/Context";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class HttpResponseCompression extends Context.Service<
  HttpResponseCompression,
  {
    readonly gzip: (
      body: Uint8Array,
      options: HttpServerResponse.Options,
    ) => HttpServerResponse.HttpServerResponse;
  }
>()("t3/HttpResponseCompression") {}

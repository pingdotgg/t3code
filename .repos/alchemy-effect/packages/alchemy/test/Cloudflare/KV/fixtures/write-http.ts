import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestNamespace } from "./namespace.ts";
import { writeRoutes } from "./write-routes.ts";

/** Write-only access via a scoped HTTP API token (`WriteNamespaceHttp`). */
export default class KVWriteHttpWorker extends Cloudflare.Worker<KVWriteHttpWorker>()(
  "KVWriteHttpWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const namespace = yield* TestNamespace;
    const kv = yield* Cloudflare.KV.WriteNamespace(namespace);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const handled = yield* writeRoutes(kv, request, url);
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.KV.WriteNamespaceHttp)),
) {}

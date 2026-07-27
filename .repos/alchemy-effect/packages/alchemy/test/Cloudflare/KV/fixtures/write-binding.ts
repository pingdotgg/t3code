import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestNamespace } from "./namespace.ts";
import { writeRoutes } from "./write-routes.ts";

/** Write-only access via the native Worker binding (`WriteNamespaceBinding`). */
export default class KVWriteBindingWorker extends Cloudflare.Worker<KVWriteBindingWorker>()(
  "KVWriteBindingWorker",
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
  }).pipe(Effect.provide(Cloudflare.KV.WriteNamespaceBinding)),
) {}

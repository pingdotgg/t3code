import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestNamespace } from "./namespace.ts";
import { readRoutes } from "./read-routes.ts";
import { writeRoutes } from "./write-routes.ts";

/** Read + write access via a scoped HTTP API token (`ReadWriteNamespaceHttp`). */
export default class KVReadWriteHttpWorker extends Cloudflare.Worker<KVReadWriteHttpWorker>()(
  "KVReadWriteHttpWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const namespace = yield* TestNamespace;
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(namespace);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        // The ReadWrite client composes both halves; route to whichever
        // matches so we exercise read *and* write through one client.
        const handled =
          (yield* writeRoutes(kv, request, url)) ??
          (yield* readRoutes(kv, url));
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceHttp)),
) {}

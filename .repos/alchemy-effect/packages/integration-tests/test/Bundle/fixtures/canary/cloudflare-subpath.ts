import * as KV from "@alchemy.run/cloudflare/KV";
import * as Workers from "@alchemy.run/cloudflare/Workers";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** The same Worker as `cloudflare-namespace.ts`, importing each service by path. */
export default class CanaryWorker extends Workers.Worker<CanaryWorker>()(
  "CanaryWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const namespace = yield* KV.Namespace("CanaryNamespace");
    const kv = yield* KV.ReadWriteNamespace(namespace);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = new URL(request.url, "http://x").searchParams.get("key") ?? "index";
        const value = yield* kv.get(key);
        return yield* HttpServerResponse.json({ value });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}

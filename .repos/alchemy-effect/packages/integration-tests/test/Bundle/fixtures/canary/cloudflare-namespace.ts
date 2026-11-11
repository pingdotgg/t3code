import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** A Worker that reaches the Cloudflare package through `import * as Cloudflare`. */
export default class CanaryWorker extends Cloudflare.Worker<CanaryWorker>()(
  "CanaryWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const namespace = yield* Cloudflare.KV.Namespace("CanaryNamespace");
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(namespace);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = new URL(request.url, "http://x").searchParams.get("key") ?? "index";
        const value = yield* kv.get(key);
        return yield* HttpServerResponse.json({ value });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding)),
) {}

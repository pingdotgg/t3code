import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import path from "pathe";

export const Bucket = Cloudflare.R2.Bucket("ExternalHostBucket", { forceDestroy: true });
export const Namespace = Cloudflare.KV.Namespace("ExternalHostNamespace");
export const Queue = Cloudflare.Queues.Queue("ExternalHostQueue");
export const Event = Schema.Struct({ key: Schema.String });
export const K2Stream = Cloudflare.K2.Stream("ExternalHostStream", { http: true, schema: Event });

export class ExternalHostLambda extends Lambda.Function<Lambda.Function>()("ExternalHostLambda") {}

/**
 * An AWS Lambda using Cloudflare `*Http` bindings: a host outside
 * Cloudflare, so each binding grants on the Lambda's minted
 * `AccountApiToken`, delivered through its env. One route per binding; a
 * failure answers 500 with the Cloudflare error.
 */
export default ExternalHostLambda.make(
  {
    main: path.resolve(import.meta.dirname, "handler.ts"),
    functionUrl: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const r2 = yield* Cloudflare.R2.ReadWriteBucket(Bucket);
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(Namespace);
    const queue = yield* Cloudflare.Queues.WriteQueue(Queue);
    const stream = yield* Cloudflare.K2.WriteStream(yield* K2Stream);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl, "http://lambda");
        const key = url.searchParams.get("key") ?? "external-host";
        switch (url.pathname) {
          case "/r2": {
            yield* r2.put(key, "from-lambda");
            const object = yield* r2.get(key);
            return yield* HttpServerResponse.json({
              value: object ? yield* object.text() : null,
            });
          }
          case "/kv": {
            yield* kv.put(key, "from-lambda");
            return yield* HttpServerResponse.json({ value: yield* kv.get(key) });
          }
          case "/queue": {
            yield* queue.send({ key });
            return yield* HttpServerResponse.json({ sent: true });
          }
          case "/k2": {
            yield* stream.send([{ key }]);
            return yield* HttpServerResponse.json({ sent: true });
          }
          default:
            return yield* HttpServerResponse.json({ ok: true });
        }
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2.ReadWriteBucketHttp,
        Cloudflare.KV.ReadWriteNamespaceHttp,
        Cloudflare.Queues.WriteQueueHttp,
        Cloudflare.K2.WriteStreamHttp,
      ),
    ),
  ),
);

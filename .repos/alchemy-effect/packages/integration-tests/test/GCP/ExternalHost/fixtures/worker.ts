import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GCP from "@alchemy.run/gcp";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const Bucket = GCP.Storage.Bucket("ExternalHostBucket", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});
export const Topic = GCP.PubSub.Topic("ExternalHostTopic", {});

/**
 * A Cloudflare Worker using GCP bindings: an external host, so each binding
 * grants on the service account Alchemy mints for the Worker and signs with
 * tokens minted from its key. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the GCP error in the test.
 */
export default class ExternalHostWorker extends Cloudflare.Worker<ExternalHostWorker>()(
  "GcpExternalHostWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const bucket = yield* GCP.Storage.ReadWriteBucket(yield* Bucket);
    const topic = yield* GCP.PubSub.WriteTopic(yield* Topic);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const key = url.searchParams.get("key") ?? "external-host";
        switch (url.pathname) {
          case "/storage":
            return yield* respond(
              Effect.gen(function* () {
                yield* bucket.put(key, "from-worker");
                const object = yield* bucket.get(key);
                return { text: object && new TextDecoder().decode(object.body) };
              }),
            );
          case "/pubsub":
            return yield* respond(
              Effect.map(topic.publish({ data: key }), (messageId) => ({ messageId })),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(GCP.Storage.ReadWriteBucketHttp, GCP.PubSub.WriteTopicHttp)),
  ),
) {}

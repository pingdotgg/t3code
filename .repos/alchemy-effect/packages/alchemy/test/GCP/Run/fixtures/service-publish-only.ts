import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { DataBucket, Tweets } from "./bound-resources.ts";

/**
 * Second deploy step of {@link ./service.ts}: same service, Storage
 * bindings removed (the bucket stays declared). The runtime service
 * account must lose its grants on the bucket.
 */
export default class BoundService extends GCP.Function<BoundService>()(
  "BoundService",
  {
    main: import.meta.url,
    location: "us-central1",
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const tweets = yield* Tweets;
    yield* DataBucket;
    const publish = yield* GCP.PubSub.Publish(tweets);

    return {
      fetch: Effect.gen(function* () {
        const { messageIds } = yield* publish({
          body: { messages: [{ data: btoa("again") }] },
        }).pipe(Effect.orDie);
        return yield* HttpServerResponse.json({
          published: (messageIds?.length ?? 0) > 0,
          step: 2,
        });
      }),
    };
  }).pipe(Effect.provide(GCP.PubSub.PublishHttp)),
) {}

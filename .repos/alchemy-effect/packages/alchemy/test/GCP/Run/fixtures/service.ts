import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { DataBucket, Tweets } from "./bound-resources.ts";

/**
 * Effect-native Cloud Run Service that binds Pub/Sub and Storage.
 * Deployed from {@link ../Service.test.ts}.
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
    const bucket = yield* DataBucket;
    const publish = yield* GCP.PubSub.Publish(tweets);
    const putObject = yield* GCP.Storage.PutObject(bucket);
    const getObject = yield* GCP.Storage.GetObject(bucket);

    return {
      fetch: Effect.gen(function* () {
        const { messageIds } = yield* publish({
          body: { messages: [{ data: btoa("hello") }] },
        }).pipe(Effect.orDie);
        yield* putObject({ name: "probe.txt", body: "stored" }).pipe(
          Effect.orDie,
        );
        const { body } = yield* getObject({ object: "probe.txt" }).pipe(
          Effect.orDie,
        );
        return yield* HttpServerResponse.json({
          published: (messageIds?.length ?? 0) > 0,
          read: new TextDecoder().decode(body),
        });
      }),
    };
  }).pipe(
    Effect.provide(GCP.PubSub.PublishHttp),
    Effect.provide(GCP.Storage.PutObjectHttp),
    Effect.provide(GCP.Storage.GetObjectHttp),
  ),
) {}

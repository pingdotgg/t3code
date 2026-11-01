import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** Bucket the function writes to from `fetch` and from topic deliveries. */
export const Marker = GCP.Storage.Bucket("FnMarker", { forceDestroy: true });
/** Topic pushed to the function through a push subscription. */
export const Pings = GCP.PubSub.Topic("FnPings", {});

/**
 * Effect-native Cloud Function: an HTTP `fetch` using Storage bindings,
 * plus a Pub/Sub push event source that records each message.
 * Deployed from {@link ../EffectNative.test.ts}.
 */
export default class EffectFunction extends GCP.CloudFunctions.Function<EffectFunction>()(
  "EffectFunction",
  { main: import.meta.url, location: "us-central1" },
  Effect.gen(function* () {
    const bucket = yield* Marker;
    const putObject = yield* GCP.Storage.PutObject(bucket);
    const getObject = yield* GCP.Storage.GetObject(bucket);

    yield* GCP.PubSub.consumeTopicMessages(yield* Pings, (messages) =>
      messages.pipe(
        Stream.runForEach(({ message }) =>
          putObject({
            name: `ping-${message.messageId}.txt`,
            body: atob(message.data ?? ""),
          }).pipe(Effect.orDie),
        ),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        yield* putObject({ name: "hello.txt", body: "from-function" }).pipe(
          Effect.orDie,
        );
        const { body } = yield* getObject({ object: "hello.txt" }).pipe(
          Effect.orDie,
        );
        return yield* HttpServerResponse.json({
          read: new TextDecoder().decode(body),
          node: yield* Effect.sync(() => process.versions.node),
        });
      }),
    };
  }).pipe(
    Effect.provide(GCP.Storage.PutObjectHttp),
    Effect.provide(GCP.Storage.GetObjectHttp),
    Effect.provide(GCP.CloudFunctions.TopicEventSource),
  ),
) {}

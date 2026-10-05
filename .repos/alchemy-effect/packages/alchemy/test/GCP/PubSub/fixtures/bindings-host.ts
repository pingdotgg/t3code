import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { serveProbes } from "../../bindingHost.ts";

/** Topic the `Publish` binding writes to; `PublishTap` observes it. */
export const PublishTopic = GCP.PubSub.Topic("PublishTopic", {});
export const PublishTap = Effect.gen(function* () {
  const topic = yield* PublishTopic;
  return yield* GCP.PubSub.Subscription("PublishTap", { topic: topic.name });
});

/** Topic the `WriteTopic` client writes to; `WriteTap` observes it. */
export const WriteTopicTarget = GCP.PubSub.Topic("WriteTopicTarget", {});
export const WriteTap = Effect.gen(function* () {
  const topic = yield* WriteTopicTarget;
  return yield* GCP.PubSub.Subscription("WriteTap", { topic: topic.name });
});

/** Subscription the `Pull` / `Acknowledge` bindings consume. */
export const PullTopic = GCP.PubSub.Topic("PullTopic", {});
export const PullInbox = Effect.gen(function* () {
  const topic = yield* PullTopic;
  return yield* GCP.PubSub.Subscription("PullInbox", {
    topic: topic.name,
    ackDeadlineSeconds: 10,
  });
});

/** Subscription the `ReadSubscription` client consumes. */
export const ReadTopic = GCP.PubSub.Topic("ReadTopic", {});
export const ReadInbox = Effect.gen(function* () {
  const topic = yield* ReadTopic;
  return yield* GCP.PubSub.Subscription("ReadInbox", {
    topic: topic.name,
    ackDeadlineSeconds: 10,
  });
});

/** Avro schema for `GetSchema` / `ValidateMessage`. */
export const EventSchema = GCP.PubSub.Schema("EventSchema", {
  type: "AVRO",
  definition: JSON.stringify({
    type: "record",
    name: "Event",
    fields: [{ name: "id", type: "string" }],
  }),
});

export const PUBLISH_PAYLOAD = "publish-binding";
export const WRITE_PAYLOAD = "write-topic-binding";
export const WRITE_BATCH_TEXT = "batch-text";
/** Binary payload: must round-trip byte for byte. */
export const WRITE_BATCH_BYTES = [0, 1, 255];

const untilSome = <A>(page: ReadonlyArray<A> | undefined) =>
  (page ?? []).length > 0;

/**
 * Effect-native Cloud Run service exercising every Pub/Sub binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class PubSubBindingsHost extends GCP.Function<PubSubBindingsHost>()(
  "PubSubBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const publish = yield* GCP.PubSub.Publish(PublishTopic);
    const pull = yield* GCP.PubSub.Pull(PullInbox);
    const acknowledge = yield* GCP.PubSub.Acknowledge(PullInbox);
    const writeTopic = yield* GCP.PubSub.WriteTopic(WriteTopicTarget);
    const readSubscription = yield* GCP.PubSub.ReadSubscription(ReadInbox);
    const getSchema = yield* GCP.PubSub.GetSchema(EventSchema);
    const validate = yield* GCP.PubSub.ValidateMessage(EventSchema);

    return {
      fetch: serveProbes({
        publish: publish({
          body: {
            messages: [
              {
                data: Buffer.from(PUBLISH_PAYLOAD).toString("base64"),
                attributes: { via: "Publish" },
              },
            ],
          },
        }),
        pullAndAcknowledge: Effect.gen(function* () {
          const page = yield* pull({
            body: { maxMessages: 10, returnImmediately: false },
          }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (page) => untilSome(page.receivedMessages),
              times: 20,
            }),
          );
          const received = page.receivedMessages ?? [];
          yield* acknowledge({
            body: { ackIds: received.map((message) => message.ackId ?? "") },
          });
          return received.map((message) =>
            Buffer.from(message.message?.data ?? "", "base64").toString("utf8"),
          );
        }),
        writeTopic: Effect.gen(function* () {
          const id = yield* writeTopic.publish({
            data: WRITE_PAYLOAD,
            attributes: { via: "WriteTopic" },
          });
          const batch = yield* writeTopic.publishBatch([
            { data: WRITE_BATCH_TEXT },
            { data: new Uint8Array(WRITE_BATCH_BYTES) },
          ]);
          const empty = yield* writeTopic.publishBatch([]);
          return { id, batch, empty };
        }),
        readSubscription: Effect.gen(function* () {
          const messages = yield* readSubscription
            .pull({ maxMessages: 10 })
            .pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: untilSome,
                times: 20,
              }),
            );
          // Extend, then acknowledge: exercises every client method.
          const ackIds = messages.map((message) => message.ackId);
          yield* readSubscription.modifyAckDeadline(ackIds, 30);
          yield* readSubscription.acknowledge(ackIds);
          return messages.map((message) => ({
            text: message.text,
            attributes: message.attributes,
          }));
        }),
        getSchema: getSchema({ view: "FULL" }),
        validateValid: validate({
          encoding: "JSON",
          message: Buffer.from(JSON.stringify({ id: "abc" })).toString(
            "base64",
          ),
        }),
        validateInvalid: validate({
          encoding: "JSON",
          message: Buffer.from(JSON.stringify({ wrong: 1 })).toString("base64"),
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.PubSub.PublishHttp),
    Effect.provide(GCP.PubSub.PullHttp),
    Effect.provide(GCP.PubSub.AcknowledgeHttp),
    Effect.provide(GCP.PubSub.WriteTopicHttp),
    Effect.provide(GCP.PubSub.ReadSubscriptionHttp),
    Effect.provide(GCP.PubSub.GetSchemaHttp),
    Effect.provide(GCP.PubSub.ValidateMessageHttp),
  ),
) {}

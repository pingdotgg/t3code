import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import * as Namespace from "../../Namespace.ts";
import { ServerHost } from "../../Server/Process.ts";
import { Acknowledge } from "../PubSub/Acknowledge.ts";
import { AcknowledgeHttp } from "../PubSub/AcknowledgeHttp.ts";
import { Pull } from "../PubSub/Pull.ts";
import { PullHttp } from "../PubSub/PullHttp.ts";
import { Subscription } from "../PubSub/Subscription.ts";
import type { Topic } from "../PubSub/Topic.ts";
import {
  TopicEventSource as PubSubTopicEventSource,
  type TopicEventSourceProps,
  type TopicEventSourceService,
  type TopicMessage,
} from "../PubSub/TopicEventSource.ts";

/**
 * Subscription `deadLetterPolicy` and `retryPolicy` for the event source's
 * props. Dead-lettering defaults to a backoff so its attempts span more
 * than a transient failure.
 */
const deliveryPolicyOf = (props: TopicEventSourceProps) => ({
  deadLetterPolicy:
    props.deadLetter === undefined
      ? undefined
      : {
          deadLetterTopic: props.deadLetter.topic.name,
          maxDeliveryAttempts: props.deadLetter.maxDeliveryAttempts ?? 5,
        },
  retryPolicy:
    props.retryPolicy ??
    (props.deadLetter === undefined
      ? undefined
      : { minimumBackoff: "10s", maximumBackoff: "600s" }),
});

/**
 * Pull implementation of `GCP.PubSub.TopicEventSource` for hosts without
 * an inbound URL (`GCP.Run.Job`, `GCP.Run.WorkerPool`; any host with
 * `ServerHost`).
 *
 * Deploy-time: creates a pull subscription owned by the host and grants
 * the host's runtime service account `roles/pubsub.subscriber` on it
 * (through the `Pull` / `Acknowledge` bindings). Runtime: a background
 * loop pulls batches, runs the handler, and acks the batch once the
 * handler succeeds. A failed handler leaves the batch unacked, so Pub/Sub
 * redelivers after the ack deadline.
 *
 * @layer
 * @provides GCP.PubSub.TopicEventSource
 * @category Run
 */
export const TopicPullEventSource = Layer.effect(
  PubSubTopicEventSource,
  Effect.gen(function* () {
    const { run } = yield* ServerHost;
    const subscription = yield* Subscription;
    const pull = yield* Pull;
    const acknowledge = yield* Acknowledge;

    return Effect.fn(function* <Req = never>(
      topic: Topic,
      props: TopicEventSourceProps,
      process: (
        messages: Stream.Stream<TopicMessage>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      const host = yield* Binding.Host;
      const hostId = host?.LogicalId ?? "Host";
      // Declared in both phases: at runtime the declaration resolves to the
      // deployed subscription's outputs, which the bindings below read.
      const sub = yield* Namespace.push(
        hostId,
        subscription(`${topic.LogicalId}-Pull`, {
          topic: topic.name,
          ackDeadlineSeconds: props.ackDeadlineSeconds ?? 60,
          filter: props.filter,
          ...deliveryPolicyOf(props),
        }),
      );
      const pullBatch = yield* pull(sub);
      const ackBatch = yield* acknowledge(sub);
      const subscriptionName = yield* sub.name;

      yield* run(
        Effect.gen(function* () {
          const name = yield* subscriptionName;
          const { receivedMessages = [] } = yield* pullBatch({
            body: { maxMessages: props.maxMessages ?? 10 },
          });
          const received = receivedMessages.filter(
            (item) => item.ackId !== undefined && item.message !== undefined,
          );
          if (received.length === 0) return;
          yield* process(
            Stream.fromIterable(
              received.map((item) => ({
                message: item.message!,
                subscription: name,
                deliveryAttempt: item.deliveryAttempt,
              })),
            ),
          );
          yield* ackBatch({
            body: { ackIds: received.map((item) => item.ackId!) },
          });
        }).pipe(
          // A failed pull, ack, or handler must not end the consumer; the
          // unacked batch is redelivered after its ack deadline.
          Effect.catchCause((cause) =>
            Effect.logWarning("Pub/Sub pull iteration failed", cause).pipe(
              Effect.andThen(Effect.sleep("1 second")),
            ),
          ),
          Effect.forever,
        ),
      );
    }) as TopicEventSourceService;
  }),
).pipe(Layer.provide(Layer.mergeAll(PullHttp, AcknowledgeHttp)));

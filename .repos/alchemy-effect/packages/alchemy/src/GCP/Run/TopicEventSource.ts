import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { Subscription } from "../PubSub/Subscription.ts";
import type { Topic } from "../PubSub/Topic.ts";
import {
  TopicEventSource as PubSubTopicEventSource,
  type TopicEventSourceProps,
  type TopicEventSourceService,
  type TopicMessage,
} from "../PubSub/TopicEventSource.ts";
import {
  deliveryAudience,
  grantSelfInvoker,
  hostEndpoint,
  listenForDeliveries,
  pathSegment,
  pushHost,
} from "../PushDelivery.ts";

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

/** Default push path for a topic's deliveries. */
export const topicPushPath = (topic: Topic, props: TopicEventSourceProps) =>
  props.path ?? `/__alchemy/pubsub/${pathSegment(topic.LogicalId)}`;

interface PushEnvelope {
  message?: TopicMessage["message"];
  subscription?: string;
  deliveryAttempt?: number;
}

/**
 * Push implementation of `GCP.PubSub.TopicEventSource` for HTTP hosts
 * (`GCP.Run.Service` / `GCP.Function`, `GCP.CloudFunctions.Function`).
 *
 * Deploy-time: grants the host's runtime service account
 * `roles/run.invoker` on the host and creates a push subscription to the
 * host's URL, signed with an OIDC token for that account. Runtime: claims
 * `POST` deliveries on the push path, verifies the token, and runs the
 * handler. 204 acks the message; a failed handler answers 500 and Pub/Sub
 * redelivers per the subscription's retry policy.
 *
 * @layer
 * @provides GCP.PubSub.TopicEventSource
 * @category Run
 */
export const TopicEventSource = Layer.effect(
  PubSubTopicEventSource,
  Effect.gen(function* () {
    const subscription = yield* Subscription;

    return Effect.fn(function* <Req = never>(
      topic: Topic,
      props: TopicEventSourceProps,
      process: (
        messages: Stream.Stream<TopicMessage>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      const host = yield* pushHost("GCP.PubSub.TopicEventSource");
      const path = topicPushPath(topic, props);

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const endpoint = hostEndpoint(host);
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* grantSelfInvoker(host);
            yield* subscription(`${topic.LogicalId}-Push`, {
              topic: topic.name,
              ackDeadlineSeconds: props.ackDeadlineSeconds ?? 60,
              filter: props.filter,
              ...deliveryPolicyOf(props),
              pushConfig: {
                pushEndpoint: Output.interpolate`${endpoint.url}${path}`,
                oidcToken: {
                  serviceAccountEmail: endpoint.serviceAccount,
                  audience: deliveryAudience(endpoint.url, path),
                },
              },
            });
          }),
        );
      }

      yield* listenForDeliveries(host, path, (request) =>
        Effect.gen(function* () {
          const envelope = (yield* request.json.pipe(
            Effect.orElseSucceed(() => undefined),
          )) as PushEnvelope | undefined;
          if (envelope?.message === undefined) {
            // Malformed deliveries can never succeed; ack so they don't loop.
            return HttpServerResponse.empty({ status: 204 });
          }
          yield* process(
            Stream.make({
              message: envelope.message,
              subscription: envelope.subscription ?? "",
              deliveryAttempt: envelope.deliveryAttempt,
            }),
          ).pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 204 });
        }),
      );
    }) as TopicEventSourceService;
  }),
);

import * as securitylake from "@distilled.cloud/aws/securitylake";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { retryWhileConflict } from "./internal.ts";

/**
 * HTTPS delivery settings for a subscriber notification.
 */
export interface SubscriberHttpsNotificationConfiguration {
  /** The HTTPS endpoint Security Lake POSTs/PUTs object notifications to. */
  endpoint: string;
  /**
   * ARN of the EventBridge API-destination role Security Lake assumes to
   * invoke the endpoint.
   */
  targetRoleArn: string;
  /**
   * Name of the API-key header sent with each notification.
   */
  authorizationApiKeyName?: string;
  /**
   * Value of the API-key header sent with each notification. Held as a
   * `Redacted` secret; it is never persisted or logged in plaintext.
   */
  authorizationApiKeyValue?: Redacted.Redacted<string>;
  /**
   * The HTTP method used to deliver notifications.
   * @default "POST"
   */
  httpMethod?: "POST" | "PUT";
}

export interface SubscriberNotificationProps {
  /**
   * ID of the `SecurityLake.Subscriber` the notification is configured for.
   * Changing this replaces the notification.
   */
  subscriberId: string;

  /**
   * Deliver new-object notifications to an AWS-managed SQS queue (Security
   * Lake creates the queue). Exactly one of `sqs` or
   * `httpsNotificationConfiguration` must be set.
   * @default false
   */
  sqs?: boolean;

  /**
   * Deliver new-object notifications to a custom HTTPS endpoint. Exactly one
   * of `sqs` or `httpsNotificationConfiguration` must be set.
   */
  httpsNotificationConfiguration?: SubscriberHttpsNotificationConfiguration;
}

/** @resource */
export interface SubscriberNotification extends Resource<
  "AWS.SecurityLake.SubscriberNotification",
  SubscriberNotificationProps,
  {
    /** ID of the subscriber the notification belongs to. */
    subscriberId: string;
    /**
     * The notification endpoint — the ARN of the AWS-managed SQS queue, or
     * the configured HTTPS endpoint.
     */
    subscriberEndpoint: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Security Lake subscriber notification — notifies a data-access
 * subscriber whenever new objects land in its Security Lake bucket, either
 * via an AWS-managed SQS queue or a custom HTTPS endpoint.
 *
 * @section Notifying subscribers
 * @example SQS notifications
 * ```typescript
 * const notification = yield* SecurityLake.SubscriberNotification("Notify", {
 *   subscriberId: subscriber.subscriberId,
 *   sqs: true,
 * });
 * ```
 *
 * @example HTTPS notifications with an API key
 * ```typescript
 * const notification = yield* SecurityLake.SubscriberNotification("Notify", {
 *   subscriberId: subscriber.subscriberId,
 *   httpsNotificationConfiguration: {
 *     endpoint: "https://ingest.example.com/securitylake",
 *     targetRoleArn: eventsRole.roleArn,
 *     authorizationApiKeyName: "x-api-key",
 *     authorizationApiKeyValue: Redacted.make("super-secret"),
 *   },
 * });
 * ```
 */
const SubscriberNotificationResource = Resource<SubscriberNotification>(
  "AWS.SecurityLake.SubscriberNotification",
);

export { SubscriberNotificationResource as SubscriberNotification };

// Build the wire NotificationConfiguration from props. Redacted secrets are
// passed through intact — distilled's SensitiveString accepts Redacted.
const toWireConfiguration = (
  props: SubscriberNotificationProps,
): securitylake.NotificationConfiguration =>
  props.httpsNotificationConfiguration !== undefined
    ? { httpsNotificationConfiguration: props.httpsNotificationConfiguration }
    : { sqsNotificationConfiguration: {} };

// A comparable, secret-free serialization of the desired configuration used
// to skip no-op updates (the API does not expose the current configuration,
// only the resulting endpoint — `olds` is the hint here).
const configFingerprint = (props: {
  sqs?: boolean;
  httpsNotificationConfiguration?: SubscriberHttpsNotificationConfiguration;
}): string => {
  const https = props.httpsNotificationConfiguration;
  return https !== undefined
    ? JSON.stringify({
        endpoint: https.endpoint,
        targetRoleArn: https.targetRoleArn,
        authorizationApiKeyName: https.authorizationApiKeyName,
        // `olds` may have round-tripped through persisted state, so the
        // secret may no longer be a live Redacted — guard before unwrapping.
        authorizationApiKeyValue:
          https.authorizationApiKeyValue !== undefined
            ? Redacted.isRedacted(https.authorizationApiKeyValue)
              ? Redacted.value(https.authorizationApiKeyValue)
              : String(https.authorizationApiKeyValue)
            : undefined,
        httpMethod: https.httpMethod ?? "POST",
      })
    : "sqs";
};

const getSubscriberEndpoint = (subscriberId: string) =>
  securitylake
    .getSubscriber({ subscriberId })
    .pipe(Effect.map((response) => response.subscriber?.subscriberEndpoint));

export const SubscriberNotificationProvider = () =>
  Provider.effect(
    SubscriberNotificationResource,
    Effect.gen(function* () {
      return {
        read: Effect.fn(function* ({ olds, output }) {
          const subscriberId = output?.subscriberId ?? olds?.subscriberId;
          if (subscriberId === undefined) return undefined;
          // A missing subscriber (or an account that never onboarded
          // Security Lake) means "no notification", not a failure.
          const endpoint = yield* getSubscriberEndpoint(subscriberId).pipe(
            Effect.catchTag(
              ["ResourceNotFoundException", "UnauthorizedException"],
              () => Effect.succeed(undefined),
            ),
          );
          // Notifications carry no tags, so ownership can't be
          // distinguished — read reports observed state directly.
          return endpoint === undefined
            ? undefined
            : { subscriberId, subscriberEndpoint: endpoint };
        }),

        // A notification exists only for subscribers that report a
        // notification endpoint.
        list: () =>
          securitylake.listSubscribers.items({}).pipe(
            Stream.filter(
              (subscriber) => subscriber.subscriberEndpoint !== undefined,
            ),
            Stream.runCollect,
            Effect.map((subscribers) =>
              [...subscribers].map((subscriber) => ({
                subscriberId: subscriber.subscriberId,
                subscriberEndpoint: subscriber.subscriberEndpoint,
              })),
            ),
            // An account that never onboarded Security Lake has no
            // subscribers to enumerate.
            Effect.catchTag(
              [
                "AccessDeniedException",
                "ResourceNotFoundException",
                "UnauthorizedException",
              ],
              () => Effect.succeed([]),
            ),
          ),

        // The notification is per-subscriber; changing the subscriber
        // replaces it.
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.subscriberId !== olds.subscriberId) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, olds, output, session }) {
          const configuration = toWireConfiguration(news);

          // 1. OBSERVE — the subscriber's current notification endpoint.
          const observedEndpoint = yield* getSubscriberEndpoint(
            news.subscriberId,
          );

          let endpoint = observedEndpoint;
          if (observedEndpoint === undefined) {
            // 2. ENSURE — create when missing. A ConflictException means a
            // concurrent create won the race; converge via update.
            endpoint = yield* securitylake
              .createSubscriberNotification({
                subscriberId: news.subscriberId,
                configuration,
              })
              .pipe(
                Effect.map((response) => response.subscriberEndpoint),
                Effect.catchTag("ConflictException", () =>
                  securitylake
                    .updateSubscriberNotification({
                      subscriberId: news.subscriberId,
                      configuration,
                    })
                    .pipe(
                      retryWhileConflict,
                      Effect.map((response) => response.subscriberEndpoint),
                    ),
                ),
              );
          } else if (
            output === undefined ||
            olds === undefined ||
            configFingerprint(olds) !== configFingerprint(news)
          ) {
            // 3. SYNC — the API reports only the endpoint, not the
            // configuration, so `olds` is the no-op hint; adoption always
            // converges via an idempotent update.
            endpoint = yield* securitylake
              .updateSubscriberNotification({
                subscriberId: news.subscriberId,
                configuration,
              })
              .pipe(
                retryWhileConflict,
                Effect.map(
                  (response) => response.subscriberEndpoint ?? endpoint,
                ),
              );
          }

          // 4. RETURN fresh attributes.
          const final =
            endpoint ?? (yield* getSubscriberEndpoint(news.subscriberId));
          yield* session.note(final ?? news.subscriberId);
          return {
            subscriberId: news.subscriberId,
            subscriberEndpoint: final,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* securitylake
            .deleteSubscriberNotification({
              subscriberId: output.subscriberId,
            })
            .pipe(
              retryWhileConflict,
              // Gone already, the subscriber was deleted first, or the data
              // lake itself was offboarded.
              Effect.catchTag(
                [
                  "AccessDeniedException",
                  "ResourceNotFoundException",
                  "UnauthorizedException",
                ],
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );

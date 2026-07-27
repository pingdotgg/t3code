import * as securitylake from "@distilled.cloud/aws/securitylake";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import { retryWhileConflict } from "./internal.ts";

export interface ExceptionSubscriptionProps {
  /**
   * The protocol used to notify the subscription endpoint, e.g. `email`,
   * `sqs`, or `https`.
   */
  subscriptionProtocol: string;

  /**
   * The endpoint Security Lake delivers exception notifications to (an email
   * address, SQS queue ARN, or HTTPS endpoint, matching the protocol).
   */
  notificationEndpoint: string;

  /**
   * How long unresolved exceptions are retained before expiring. Accepts any
   * `Duration.Input` (e.g. `"30 days"`, `Duration.days(30)`; a bare number is
   * milliseconds); the wire unit is whole days.
   * @default - exceptions do not expire
   */
  exceptionTimeToLive?: Duration.Input;
}

/** @resource */
export interface ExceptionSubscription extends Resource<
  "AWS.SecurityLake.ExceptionSubscription",
  ExceptionSubscriptionProps,
  {
    /** The protocol used to notify the subscription endpoint. */
    subscriptionProtocol: string;
    /** The endpoint that receives exception notifications. */
    notificationEndpoint: string;
    /** Retention of unresolved exceptions, in whole days. */
    exceptionTimeToLive: number | undefined;
  },
  never,
  Providers
> {}

/**
 * The Amazon Security Lake exception notification subscription — an
 * account-Region singleton that delivers notifications (via SNS protocols
 * like email, SQS, or HTTPS) whenever Security Lake hits an exception it
 * cannot resolve automatically.
 *
 * @section Subscribing to exceptions
 * @example Email notifications
 * ```typescript
 * const exceptions = yield* SecurityLake.ExceptionSubscription("Exceptions", {
 *   subscriptionProtocol: "email",
 *   notificationEndpoint: "security-team@example.com",
 * });
 * ```
 *
 * @example SQS notifications with a 30-day exception TTL
 * ```typescript
 * const exceptions = yield* SecurityLake.ExceptionSubscription("Exceptions", {
 *   subscriptionProtocol: "sqs",
 *   notificationEndpoint: queue.queueArn,
 *   exceptionTimeToLive: "30 days",
 * });
 * ```
 */
const ExceptionSubscriptionResource = Resource<ExceptionSubscription>(
  "AWS.SecurityLake.ExceptionSubscription",
);

export { ExceptionSubscriptionResource as ExceptionSubscription };

// Observation for read/list: an account that never onboarded Security Lake
// (or has no subscription) yields "missing", not a failure.
const observeSubscription = securitylake
  .getDataLakeExceptionSubscription({})
  .pipe(
    Effect.map((response) =>
      response.notificationEndpoint !== undefined &&
      response.subscriptionProtocol !== undefined
        ? {
            subscriptionProtocol: response.subscriptionProtocol,
            notificationEndpoint: response.notificationEndpoint,
            exceptionTimeToLive: response.exceptionTimeToLive,
          }
        : undefined,
    ),
    Effect.catchTag(
      [
        "AccessDeniedException",
        "ResourceNotFoundException",
        "UnauthorizedException",
      ],
      () => Effect.succeed(undefined),
    ),
  );

export const ExceptionSubscriptionProvider = () =>
  Provider.effect(
    ExceptionSubscriptionResource,
    Effect.gen(function* () {
      return {
        // The subscription carries no tags and is an account-Region
        // singleton — read reports observed state directly.
        read: Effect.fn(function* () {
          return yield* observeSubscription;
        }),

        list: () =>
          Effect.gen(function* () {
            const observed = yield* observeSubscription;
            return observed === undefined ? [] : [observed];
          }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const desired = {
            subscriptionProtocol: news.subscriptionProtocol,
            notificationEndpoint: news.notificationEndpoint,
            exceptionTimeToLive: toWireDays(news.exceptionTimeToLive),
          };

          // 1. OBSERVE — the singleton's current state.
          const observed = yield* observeSubscription;

          // 2. ENSURE — create when missing; a ConflictException means a
          // concurrent create won the race, so converge via update below.
          if (observed === undefined) {
            yield* securitylake
              .createDataLakeExceptionSubscription(desired)
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  securitylake
                    .updateDataLakeExceptionSubscription(desired)
                    .pipe(retryWhileConflict),
                ),
              );
          } else if (
            observed.subscriptionProtocol !== desired.subscriptionProtocol ||
            observed.notificationEndpoint !== desired.notificationEndpoint ||
            observed.exceptionTimeToLive !== desired.exceptionTimeToLive
          ) {
            // 3. SYNC — apply only when observed differs from desired.
            yield* securitylake
              .updateDataLakeExceptionSubscription(desired)
              .pipe(retryWhileConflict);
          }

          // 4. RETURN fresh attributes.
          const final = (yield* observeSubscription) ?? {
            subscriptionProtocol: desired.subscriptionProtocol,
            notificationEndpoint: desired.notificationEndpoint,
            exceptionTimeToLive: desired.exceptionTimeToLive,
          };
          yield* session.note(
            `${final.subscriptionProtocol}:${final.notificationEndpoint}`,
          );
          return final;
        }),

        delete: Effect.fn(function* () {
          yield* securitylake.deleteDataLakeExceptionSubscription({}).pipe(
            retryWhileConflict,
            // Gone already, or the account was never onboarded.
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

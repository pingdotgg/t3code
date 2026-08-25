import * as notifications from "@distilled.cloud/aws/notifications";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { pinNotificationsRegion } from "./internal.ts";

export interface EventRuleProps {
  /**
   * The ARN of the {@link NotificationConfiguration} this rule feeds.
   * Changing the configuration replaces the rule.
   */
  notificationConfigurationArn: string;

  /**
   * The EventBridge event source, e.g. `aws.s3`, `aws.cloudwatch`,
   * `aws.ec2`. Changing the source replaces the rule.
   */
  source: string;

  /**
   * The event type emitted by the source, e.g. `Object Created`,
   * `CloudWatch Alarm State Change`, `EC2 Instance State-change
   * Notification`. Changing the event type replaces the rule.
   */
  eventType: string;

  /**
   * Optional EventBridge event pattern that further restricts which events
   * match. Provided as a JSON string or a plain pattern object. When
   * omitted, all events of `source`/`eventType` match.
   */
  eventPattern?: string | Record<string, any>;

  /**
   * The AWS regions whose events this rule captures. User Notifications
   * creates a managed EventBridge rule in each listed region.
   */
  regions: string[];
}

export interface EventRule extends Resource<
  "AWS.Notifications.EventRule",
  EventRuleProps,
  {
    /** The ARN of the event rule. */
    eventRuleArn: string;
    /** The ARN of the parent notification configuration. */
    notificationConfigurationArn: string;
    /** The EventBridge event source. */
    source: string;
    /** The event type. */
    eventType: string;
    /** The regions whose events the rule captures. */
    regions: string[];
  },
  never,
  Providers
> {}

/**
 * An AWS User Notifications **event rule** — attaches an EventBridge
 * source/event-type (optionally narrowed by an event pattern) to a
 * {@link NotificationConfiguration}, across one or more regions.
 *
 * `source`, `eventType` and the parent configuration are immutable
 * (changing them replaces the rule); `eventPattern` and `regions` update
 * in place. User Notifications materializes a managed EventBridge rule in
 * every listed region.
 *
 * @resource
 * @section Creating an Event Rule
 * @example Notify on S3 object creation
 * ```typescript
 * import * as Notifications from "alchemy/AWS/Notifications";
 *
 * const config = yield* Notifications.NotificationConfiguration("Alerts");
 * const rule = yield* Notifications.EventRule("S3Created", {
 *   notificationConfigurationArn: config.notificationConfigurationArn,
 *   source: "aws.s3",
 *   eventType: "Object Created",
 *   regions: ["us-west-2"],
 * });
 * ```
 *
 * @example Restrict matches with an event pattern
 * ```typescript
 * const rule = yield* Notifications.EventRule("BucketRule", {
 *   notificationConfigurationArn: config.notificationConfigurationArn,
 *   source: "aws.s3",
 *   eventType: "Object Created",
 *   eventPattern: { detail: { bucket: { name: ["my-bucket"] } } },
 *   regions: ["us-west-2", "us-east-2"],
 * });
 * ```
 */
export const EventRule = Resource<EventRule>("AWS.Notifications.EventRule");

/** Normalize an `eventPattern` prop to the wire JSON string ("" = none). */
const toPatternString = (
  pattern: string | Record<string, any> | undefined,
): string =>
  pattern === undefined
    ? ""
    : typeof pattern === "string"
      ? pattern
      : JSON.stringify(pattern);

/** Order-insensitive region list equality. */
const sameRegions = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

/**
 * Poll a rule until no region is in a transitional state (`CREATING` /
 * `UPDATING` / `DELETING`). Bounded and fail-open — regional propagation
 * completes in seconds and a still-pending region is not an error.
 *
 * Expressed as an explicitly-typed helper: inlining `Effect.repeat` in the
 * provider leaves its conditional return type unresolved in declaration
 * emit, widening the provider layer to an `unknown` R.
 */
const untilSettled = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  pending: (a: A) => boolean,
): Effect.Effect<A, E, R> =>
  Effect.repeat(self, {
    schedule: Schedule.fixed("2 seconds"),
    until: (a) => !pending(a),
    times: 20,
  });

/**
 * Retry an operation while the service reports a transitional-lock
 * `ConflictException` (e.g. "event rule ... has not reached terminal status
 * in region(s): us-west-2 - DELETING"). User Notifications serializes rule
 * mutations per configuration, so a create that races a sibling delete is
 * rejected until the delete settles. Bounded (~40s).
 */
const retryWhileConflict = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(20)]),
  });

/**
 * Poll an observation until the resource is gone (bounded, fail-open).
 * Rule deletion is asynchronous (regions transition through `DELETING`);
 * returning before it settles trips ConflictExceptions in follow-up
 * operations on the same configuration.
 */
const pollUntilGone = <A, E, R>(
  self: Effect.Effect<A | undefined, E, R>,
): Effect.Effect<A | undefined, E, R> =>
  Effect.repeat(self, {
    schedule: Schedule.fixed("2 seconds"),
    until: (a) => a === undefined,
    times: 20,
  });

const hasPendingRegion = (rule: {
  statusSummaryByRegion: {
    [key: string]: { status: string } | undefined;
  };
}): boolean =>
  Object.values(rule.statusSummaryByRegion).some(
    (s) =>
      s !== undefined &&
      (s.status === "CREATING" ||
        s.status === "UPDATING" ||
        s.status === "DELETING"),
  );

export const EventRuleProvider = () =>
  Provider.effect(
    EventRule,
    Effect.gen(function* () {
      const getByArn = Effect.fn(function* (arn: string) {
        return yield* pinNotificationsRegion(
          notifications
            .getEventRule({ arn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            ),
        );
      });

      // Identity fallback when the ARN cache is missing: scan the parent
      // configuration's rules for the (source, eventType) pair.
      const findBySignature = Effect.fn(function* (
        notificationConfigurationArn: string,
        source: string,
        eventType: string,
      ) {
        return yield* pinNotificationsRegion(
          notifications.listEventRules
            .items({ notificationConfigurationArn })
            .pipe(
              Stream.filter(
                (rule) =>
                  rule.source === source && rule.eventType === eventType,
              ),
              Stream.runHead,
              Effect.map(Option.getOrUndefined),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            ),
        );
      });

      const toAttrs = (live: {
        arn: string;
        notificationConfigurationArn: string;
        source: string;
        eventType: string;
        regions: readonly string[];
      }) => ({
        eventRuleArn: live.arn,
        notificationConfigurationArn: live.notificationConfigurationArn,
        source: live.source,
        eventType: live.eventType,
        regions: [...live.regions],
      });

      return EventRule.Provider.of({
        stables: [
          "eventRuleArn",
          "notificationConfigurationArn",
          "source",
          "eventType",
        ],

        // Sub-resource keyed by its parent notification configuration —
        // there is no account-wide enumeration without a parent ARN.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const found = output?.eventRuleArn
            ? yield* getByArn(output.eventRuleArn)
            : olds
              ? yield* findBySignature(
                  olds.notificationConfigurationArn,
                  olds.source,
                  olds.eventType,
                )
              : undefined;
          // Event rules are not taggable, so ownership can't be verified —
          // identity via the parent-scoped (source, eventType) signature.
          return found ? toAttrs(found) : undefined;
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.notificationConfigurationArn !==
              olds.notificationConfigurationArn ||
            news.source !== olds.source ||
            news.eventType !== olds.eventType
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const desiredPattern = toPatternString(news.eventPattern);

          // OBSERVE — cloud state is authoritative; the cached ARN falls
          // through to a parent-scoped signature scan.
          let live = output?.eventRuleArn
            ? yield* getByArn(output.eventRuleArn)
            : yield* findBySignature(
                news.notificationConfigurationArn,
                news.source,
                news.eventType,
              );

          // ENSURE — create when missing; ConflictException means a peer
          // created the same rule concurrently → re-observe.
          if (live === undefined) {
            // Retry the transitional lock (a sibling rule still DELETING);
            // a conflict that persists past the budget means the same rule
            // already exists → re-observe by signature.
            const created = yield* retryWhileConflict(
              pinNotificationsRegion(
                notifications.createEventRule({
                  notificationConfigurationArn:
                    news.notificationConfigurationArn,
                  source: news.source,
                  eventType: news.eventType,
                  ...(desiredPattern !== ""
                    ? { eventPattern: desiredPattern }
                    : {}),
                  regions: news.regions,
                }),
              ),
            ).pipe(
              Effect.catchTag("ConflictException", () =>
                Effect.succeed(undefined),
              ),
            );
            live = created
              ? yield* getByArn(created.arn)
              : yield* findBySignature(
                  news.notificationConfigurationArn,
                  news.source,
                  news.eventType,
                );
          }
          const arn = live!.arn;

          // SYNC — diff observed eventPattern/regions against desired and
          // apply only the delta.
          if (
            live!.eventPattern !== desiredPattern ||
            !sameRegions(live!.regions, news.regions)
          ) {
            yield* retryWhileConflict(
              pinNotificationsRegion(
                notifications.updateEventRule({
                  arn,
                  eventPattern: desiredPattern,
                  regions: news.regions,
                }),
              ),
            );
          }

          // Wait for regional managed rules to settle (bounded, fail-open).
          const settled = yield* untilSettled(
            pinNotificationsRegion(notifications.getEventRule({ arn })),
            hasPendingRegion,
          );

          yield* session.note(arn);
          return toAttrs(settled);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent — the parent configuration's deletion cascades rules,
          // so the rule may already be gone. A ConflictException means a
          // sibling mutation is still settling — retry through it.
          yield* retryWhileConflict(
            pinNotificationsRegion(
              notifications.deleteEventRule({ arn: output.eventRuleArn }),
            ),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          // Deletion is asynchronous — wait until the rule is actually gone
          // so follow-up mutations on the configuration don't hit the
          // transitional lock (bounded, fail-open).
          yield* pollUntilGone(getByArn(output.eventRuleArn));
        }),
      });
    }),
  );

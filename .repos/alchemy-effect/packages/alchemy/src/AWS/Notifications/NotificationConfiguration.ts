import * as notifications from "@distilled.cloud/aws/notifications";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  pinNotificationsRegion,
  readNotificationsTags,
  syncNotificationsTags,
} from "./internal.ts";

/**
 * How long User Notifications aggregates events of the same kind into a
 * single notification before delivering it.
 */
export type AggregationDuration = "LONG" | "SHORT" | "NONE";

export interface NotificationConfigurationProps {
  /**
   * Name of the notification configuration. Must be unique in the account
   * (letters, numbers, underscores and hyphens). If omitted, a unique name
   * is generated from the app, stage and logical ID. The name can be
   * changed in place (no replacement).
   */
  name?: string;

  /**
   * Human-readable description of the configuration.
   * @default "Managed by Alchemy"
   */
  description?: string;

  /**
   * How long to aggregate matching events into a single notification:
   * `LONG` (12 hours), `SHORT` (5 minutes) or `NONE` (no aggregation).
   * @default "NONE"
   */
  aggregationDuration?: AggregationDuration;

  /**
   * User tags to attach to the configuration. Merged with internal
   * Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface NotificationConfiguration extends Resource<
  "AWS.Notifications.NotificationConfiguration",
  NotificationConfigurationProps,
  {
    /** The ARN of the notification configuration (regionless). */
    notificationConfigurationArn: string;
    /** The unique name of the configuration. */
    name: string;
    /** The description of the configuration. */
    description: string;
    /**
     * Current status: `ACTIVE`, `PARTIALLY_ACTIVE`, `INACTIVE` (no event
     * rules / channels associated yet) or `DELETING`.
     */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An AWS User Notifications **notification configuration** — the container
 * that groups {@link EventRule}s (which events to notify on) and delivery
 * channels (where notifications go: Console bell, email contacts, chat).
 *
 * User Notifications is a global service managed from `us-east-1`; the
 * provider pins the control-plane region automatically, so the resource
 * works from a stack deployed in any region.
 *
 * @resource
 * @section Creating a Notification Configuration
 * @example Basic configuration
 * ```typescript
 * import * as Notifications from "alchemy/AWS/Notifications";
 *
 * const config = yield* Notifications.NotificationConfiguration("Alerts", {
 *   description: "Deployment alerts",
 * });
 * ```
 *
 * @example Aggregate duplicate events for 5 minutes
 * ```typescript
 * const config = yield* Notifications.NotificationConfiguration("Alerts", {
 *   description: "Deployment alerts",
 *   aggregationDuration: "SHORT",
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @section Adding Event Rules
 * @example Notify on CloudWatch alarm state changes
 * ```typescript
 * const rule = yield* Notifications.EventRule("AlarmRule", {
 *   notificationConfigurationArn: config.notificationConfigurationArn,
 *   source: "aws.cloudwatch",
 *   eventType: "CloudWatch Alarm State Change",
 *   regions: ["us-west-2"],
 * });
 * ```
 */
export const NotificationConfiguration = Resource<NotificationConfiguration>(
  "AWS.Notifications.NotificationConfiguration",
);

const DEFAULT_DESCRIPTION = "Managed by Alchemy";

/**
 * Retry a mutation while the service reports a transitional-lock
 * `ConflictException` (e.g. an event rule of this configuration is still
 * `DELETING`). Bounded (~40s). Explicitly typed so `Effect.retry`'s
 * conditional return type doesn't widen the provider layer in declaration
 * emit.
 */
const retryWhileConflict = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(20)]),
  });

export const NotificationConfigurationProvider = () =>
  Provider.effect(
    NotificationConfiguration,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: NotificationConfigurationProps,
      ) {
        return props.name ?? (yield* createPhysicalName({ id }));
      });

      // Names are unique account-wide (CreateNotificationConfiguration
      // rejects duplicates with ConflictException), so a name scan is a
      // reliable identity fallback when the ARN cache is missing.
      const findByName = Effect.fn(function* (name: string) {
        return yield* pinNotificationsRegion(
          notifications.listNotificationConfigurations.items({}).pipe(
            Stream.filter((item) => item.name === name),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          ),
        );
      });

      const getByArn = Effect.fn(function* (arn: string) {
        return yield* pinNotificationsRegion(
          notifications
            .getNotificationConfiguration({ arn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            ),
        );
      });

      const toAttrs = (live: {
        arn: string;
        name: string;
        description: string;
        status: string;
      }) => ({
        notificationConfigurationArn: live.arn,
        name: live.name,
        description: live.description,
        status: live.status,
      });

      return NotificationConfiguration.Provider.of({
        stables: ["notificationConfigurationArn"],

        list: () =>
          pinNotificationsRegion(
            notifications.listNotificationConfigurations.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk).map(toAttrs)),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const found = output?.notificationConfigurationArn
            ? yield* getByArn(output.notificationConfigurationArn)
            : yield* findByName(name);
          if (!found) return undefined;
          const attrs = toAttrs(found);
          const tags = yield* readNotificationsTags(found.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // Everything (including the name) is mutable in place — no diff
        // needed; the engine's default update path always reconciles.

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const desiredName = yield* createName(id, news);
          const desiredDescription = news.description ?? DEFAULT_DESCRIPTION;

          // OBSERVE — cloud state is authoritative; the cached ARN falls
          // through to a name scan when it no longer resolves.
          let live = output?.notificationConfigurationArn
            ? yield* getByArn(output.notificationConfigurationArn)
            : yield* findByName(desiredName);

          // ENSURE — create when missing; ConflictException means a peer
          // created the same-named configuration concurrently → re-observe.
          if (live === undefined) {
            const created = yield* pinNotificationsRegion(
              notifications
                .createNotificationConfiguration({
                  name: desiredName,
                  description: desiredDescription,
                  aggregationDuration: news.aggregationDuration,
                  tags: news.tags,
                })
                .pipe(
                  Effect.catchTag("ConflictException", () =>
                    Effect.succeed(undefined),
                  ),
                ),
            );
            live = created
              ? yield* getByArn(created.arn)
              : yield* findByName(desiredName);
          }
          const arn = live!.arn;

          // SYNC settings — diff observed name/description/aggregation
          // against desired and update only on change. An absent
          // aggregationDuration prop leaves the observed value untouched.
          const wantsAggregation = news.aggregationDuration;
          const aggregationDrifted =
            wantsAggregation !== undefined &&
            (live!.aggregationDuration ?? "NONE") !== wantsAggregation;
          if (
            live!.name !== desiredName ||
            live!.description !== desiredDescription ||
            aggregationDrifted
          ) {
            yield* pinNotificationsRegion(
              notifications.updateNotificationConfiguration({
                arn,
                name: desiredName,
                description: desiredDescription,
                ...(wantsAggregation !== undefined
                  ? { aggregationDuration: wantsAggregation }
                  : {}),
              }),
            );
          }

          // SYNC tags — against observed cloud tags (adoption-safe).
          yield* syncNotificationsTags(arn, id, news.tags);

          const fresh = yield* getByArn(arn);
          yield* session.note(arn);
          return toAttrs(fresh ?? live!);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent — deleting also cascades any remaining event rules.
          // Retry the transitional lock (a rule still DELETING blocks the
          // configuration delete with a ConflictException).
          yield* retryWhileConflict(
            pinNotificationsRegion(
              notifications.deleteNotificationConfiguration({
                arn: output.notificationConfigurationArn,
              }),
            ),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );

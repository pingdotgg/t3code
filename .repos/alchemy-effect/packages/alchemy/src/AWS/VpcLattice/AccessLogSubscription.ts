import * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { retryOnConflict } from "./internal.ts";

/**
 * Which traffic a service-network access log subscription captures.
 */
export type ServiceNetworkLogType = "SERVICE" | "RESOURCE";

/** The delivery service encoded in a destination ARN (`arn:aws:<service>:…`). */
const destinationType = (arn: string) => arn.split(":")[2] ?? "";

/**
 * Normalize a destination ARN for comparison — CloudWatch log-group ARNs
 * round-trip through the API with a trailing `:*`.
 */
const normalizeDestinationArn = (arn: string) => arn.replace(/:\*$/, "");

export interface AccessLogSubscriptionProps {
  /**
   * ID or ARN of the service network or lattice service whose traffic is
   * logged. Immutable — changing it replaces the subscription.
   */
  resourceIdentifier: string;
  /**
   * ARN of the delivery destination: a CloudWatch log group, Firehose
   * delivery stream, or S3 bucket. The destination can be updated in place,
   * but changing the destination *type* (e.g. CloudWatch → S3) replaces the
   * subscription.
   */
  destinationArn: string;
  /**
   * For service networks, whether to log traffic to lattice services or to
   * shared VPC resources. Immutable — changing it replaces the subscription.
   * @default "SERVICE"
   */
  serviceNetworkLogType?: ServiceNetworkLogType;
  /**
   * User-defined tags to apply to the subscription.
   */
  tags?: Record<string, string>;
}

export interface AccessLogSubscription extends Resource<
  "AWS.VpcLattice.AccessLogSubscription",
  AccessLogSubscriptionProps,
  {
    /**
     * Service-assigned unique ID of the subscription.
     */
    accessLogSubscriptionId: string;
    /**
     * ARN of the subscription.
     */
    accessLogSubscriptionArn: string;
    /**
     * ID of the service network or service whose traffic is logged.
     */
    resourceId: string;
    /**
     * ARN of the service network or service whose traffic is logged.
     */
    resourceArn: string;
    /**
     * ARN of the delivery destination.
     */
    destinationArn: string;
    /**
     * Current tags reported for the subscription.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon VPC Lattice access log subscription — delivers per-request
 * access logs for a service network or lattice service to CloudWatch Logs,
 * Kinesis Data Firehose, or S3.
 *
 * @resource
 * @section Creating Access Log Subscriptions
 * @example Log a Service Network to CloudWatch
 * ```typescript
 * const logs = yield* AccessLogSubscription("NetworkLogs", {
 *   resourceIdentifier: network.serviceNetworkId,
 *   destinationArn: logGroup.logGroupArn,
 * });
 * ```
 *
 * @example Log a Service to S3
 * ```typescript
 * const logs = yield* AccessLogSubscription("ServiceLogs", {
 *   resourceIdentifier: service.serviceId,
 *   destinationArn: bucket.bucketArn,
 * });
 * ```
 */
export const AccessLogSubscription = Resource<AccessLogSubscription>(
  "AWS.VpcLattice.AccessLogSubscription",
);

export const AccessLogSubscriptionProvider = () =>
  Provider.effect(
    AccessLogSubscription,
    Effect.gen(function* () {
      const observe = (id: string) =>
        vpclattice
          .getAccessLogSubscription({ accessLogSubscriptionIdentifier: id })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      // A resource can hold at most one subscription per destination type;
      // recover the existing one for our destination's type.
      const findByDestinationType = (
        resourceIdentifier: string,
        desiredDestinationArn: string,
      ) =>
        vpclattice.listAccessLogSubscriptions
          .pages({ resourceIdentifier })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.items ?? [])
                .find(
                  (s) =>
                    destinationType(s.destinationArn) ===
                    destinationType(desiredDestinationArn),
                ),
            ),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const syncTags = Effect.fn(function* (
        arn: string,
        desiredTags: Record<string, string>,
      ) {
        const listed = yield* vpclattice.listTagsForResource({
          resourceArn: arn,
        });
        const { removed, upsert } = diffTags(
          tagRecord(listed.tags),
          desiredTags,
        );
        if (upsert.length > 0) {
          yield* vpclattice.tagResource({
            resourceArn: arn,
            tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
          });
        }
        if (removed.length > 0) {
          yield* vpclattice.untagResource({
            resourceArn: arn,
            tagKeys: removed,
          });
        }
      });

      return {
        stables: [
          "accessLogSubscriptionId",
          "accessLogSubscriptionArn",
          "resourceId",
          "resourceArn",
        ],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            olds?.resourceIdentifier !== news.resourceIdentifier ||
            (olds?.serviceNetworkLogType ?? undefined) !==
              news.serviceNetworkLogType
          ) {
            return { action: "replace" } as const;
          }
          // The destination is mutable in place, but only within the same
          // destination service (CloudWatch/Firehose/S3).
          if (
            olds !== undefined &&
            destinationType(olds.destinationArn) !==
              destinationType(news.destinationArn)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const subscription = output?.accessLogSubscriptionId
            ? yield* observe(output.accessLogSubscriptionId)
            : olds
              ? yield* findByDestinationType(
                  olds.resourceIdentifier,
                  olds.destinationArn,
                )
              : undefined;
          if (!subscription) return undefined;
          const listed = yield* vpclattice.listTagsForResource({
            resourceArn: subscription.arn,
          });
          const attrs = {
            accessLogSubscriptionId: subscription.id,
            accessLogSubscriptionArn: subscription.arn,
            resourceId: subscription.resourceId,
            resourceArn: subscription.resourceArn,
            destinationArn: subscription.destinationArn,
            tags: tagRecord(listed.tags),
          };
          return (yield* hasAlchemyTags(id, listed.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the stable id cache, fall back to discovering
          // the resource's subscription for our destination type. The create
          // response carries the same identifying fields but no timestamps,
          // so keep the local shape to the fields we actually use.
          let subscription:
            | {
                id: string;
                arn: string;
                resourceId: string;
                resourceArn: string;
                destinationArn: string;
              }
            | undefined = output?.accessLogSubscriptionId
            ? yield* observe(output.accessLogSubscriptionId)
            : yield* findByDestinationType(
                news.resourceIdentifier,
                news.destinationArn,
              );

          // Ensure — create if missing. A ConflictException means a
          // subscription for this destination type already exists (a race);
          // recover it and converge below.
          if (!subscription) {
            const created = yield* retryOnConflict(
              vpclattice.createAccessLogSubscription({
                resourceIdentifier: news.resourceIdentifier,
                destinationArn: news.destinationArn,
                serviceNetworkLogType: news.serviceNetworkLogType,
                tags: desiredTags,
              }),
            ).pipe(
              Effect.catchTag("ConflictException", () =>
                findByDestinationType(
                  news.resourceIdentifier,
                  news.destinationArn,
                ),
              ),
            );
            if (!created) {
              return yield* Effect.fail(
                new Error("Failed to create access log subscription"),
              );
            }
            subscription = created;
          }

          // Sync destination — mutable within the same destination type.
          if (
            normalizeDestinationArn(subscription.destinationArn) !==
            normalizeDestinationArn(news.destinationArn)
          ) {
            yield* vpclattice.updateAccessLogSubscription({
              accessLogSubscriptionIdentifier: subscription.id,
              destinationArn: news.destinationArn,
            });
          }

          yield* syncTags(subscription.arn, desiredTags);

          yield* session.note(subscription.arn);
          return {
            accessLogSubscriptionId: subscription.id,
            accessLogSubscriptionArn: subscription.arn,
            resourceId: subscription.resourceId,
            resourceArn: subscription.resourceArn,
            destinationArn: news.destinationArn,
            tags: desiredTags,
          };
        }),
        // Sub-resource: subscriptions are keyed by their service network /
        // service and are removed with it, so nuke has nothing to enumerate.
        list: () => Effect.succeed([] as AccessLogSubscription["Attributes"][]),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOnConflict(
            vpclattice.deleteAccessLogSubscription({
              accessLogSubscriptionIdentifier: output.accessLogSubscriptionId,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );

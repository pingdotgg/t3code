import * as config from "@distilled.cloud/aws/config-service";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface DeliveryChannelProps {
  /**
   * Name of the delivery channel. AWS allows only ONE delivery channel per
   * account per region. Changing the name replaces the channel.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Name of the S3 bucket AWS Config delivers configuration snapshots and
   * history files to. The bucket needs a policy granting
   * `config.amazonaws.com` `s3:GetBucketAcl` on the bucket and
   * `s3:PutObject` on `arn:aws:s3:::{bucket}/AWSLogs/{account}/Config/*`.
   */
  s3BucketName: string;
  /**
   * Key prefix for the delivered objects.
   */
  s3KeyPrefix?: string;
  /**
   * ARN of the KMS key AWS Config uses to encrypt objects delivered to the
   * S3 bucket.
   */
  s3KmsKeyArn?: string;
  /**
   * ARN of the SNS topic AWS Config sends notifications to.
   */
  snsTopicArn?: string;
  /**
   * How often AWS Config delivers configuration snapshots to the bucket.
   */
  snapshotDeliveryFrequency?:
    | "One_Hour"
    | "Three_Hours"
    | "Six_Hours"
    | "Twelve_Hours"
    | "TwentyFour_Hours";
}

export interface DeliveryChannel extends Resource<
  "AWS.Config.DeliveryChannel",
  DeliveryChannelProps,
  {
    /** Physical name of the delivery channel. */
    deliveryChannelName: string;
    /** S3 bucket configuration snapshots and history are delivered to. */
    s3BucketName: string;
  },
  never,
  Providers
> {}

/**
 * The AWS Config delivery channel that delivers configuration snapshots and
 * configuration history to an S3 bucket (and optionally notifies an SNS
 * topic).
 *
 * AWS allows only **one** delivery channel per account per region — treat
 * this resource as an account-region singleton. A configuration recorder
 * must exist before the channel can be created (see
 * `AWS.Config.ConfigurationRecorder`).
 * @resource
 * @section Creating the Channel
 * @example Deliver configuration history to S3
 * ```typescript
 * import * as Config from "alchemy/AWS/Config";
 *
 * const channel = yield* Config.DeliveryChannel("Channel", {
 *   s3BucketName: bucket.bucketName,
 * });
 * ```
 *
 * @example Periodic snapshots with a key prefix
 * ```typescript
 * const channel = yield* Config.DeliveryChannel("Channel", {
 *   s3BucketName: bucket.bucketName,
 *   s3KeyPrefix: "config",
 *   snapshotDeliveryFrequency: "TwentyFour_Hours",
 * });
 * ```
 */
export const DeliveryChannel = Resource<DeliveryChannel>(
  "AWS.Config.DeliveryChannel",
);

/**
 * `PutDeliveryChannel` validates the recorder's existence and the bucket
 * policy at call time. A recorder or bucket policy created in the same
 * deploy can take a few seconds to become visible, surfacing as
 * `NoAvailableConfigurationRecorderException` /
 * `InsufficientDeliveryPolicyException` / `NoSuchBucketException` — retry
 * on a bounded schedule (~40s).
 *
 * Explicitly typed: inlining `Effect.retry` with options in provider
 * lifecycle code can widen the provider layer to `unknown` in declaration
 * emit.
 *
 * @internal
 */
const retryChannelPut = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "NoAvailableConfigurationRecorderException" ||
      e._tag === "InsufficientDeliveryPolicyException" ||
      e._tag === "NoSuchBucketException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(20)]),
  });

/**
 * Deleting the channel while the recorder is still running (or while the
 * recorder is being stopped/deleted concurrently by the same destroy)
 * rejects with `LastDeliveryChannelDeleteFailedException` — a dependency
 * violation, retried on a bounded schedule (~40s).
 * @internal
 */
const retryChannelDelete = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "LastDeliveryChannelDeleteFailedException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(20)]),
  });

export const DeliveryChannelProvider = () =>
  Provider.effect(
    DeliveryChannel,
    Effect.gen(function* () {
      const createChannelName = Effect.fn(function* (
        id: string,
        props: Pick<DeliveryChannelProps, "name">,
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const toWireChannel = (
        name: string,
        props: DeliveryChannelProps,
      ): config.DeliveryChannel => ({
        name,
        s3BucketName: props.s3BucketName,
        s3KeyPrefix: props.s3KeyPrefix,
        s3KmsKeyArn: props.s3KmsKeyArn,
        snsTopicARN: props.snsTopicArn,
        configSnapshotDeliveryProperties:
          props.snapshotDeliveryFrequency === undefined
            ? undefined
            : { deliveryFrequency: props.snapshotDeliveryFrequency },
      });

      const observeChannel = Effect.fn(function* (name: string) {
        const response = yield* config
          .describeDeliveryChannels({ DeliveryChannelNames: [name] })
          .pipe(
            Effect.catchTag("NoSuchDeliveryChannelException", () =>
              Effect.succeed({ DeliveryChannels: [] }),
            ),
          );
        return (response.DeliveryChannels ?? []).at(0);
      });

      return DeliveryChannel.Provider.of({
        stables: ["deliveryChannelName"],
        list: () =>
          config.describeDeliveryChannels({}).pipe(
            Effect.map((response) =>
              (response.DeliveryChannels ?? []).flatMap((channel) =>
                channel.name && channel.s3BucketName
                  ? [
                      {
                        deliveryChannelName: channel.name,
                        s3BucketName: channel.s3BucketName,
                      },
                    ]
                  : [],
              ),
            ),
          ),
        // Delivery channels are not taggable, so there is no ownership
        // marker to check — an existing channel with our derived name is
        // treated as ours.
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.deliveryChannelName ??
            (yield* createChannelName(id, olds ?? {}));
          const channel = yield* observeChannel(name);
          if (channel?.name === undefined) return undefined;
          return {
            deliveryChannelName: channel.name,
            s3BucketName: channel.s3BucketName!,
          };
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createChannelName(id, olds ?? {});
          const newName = yield* createChannelName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update logic for mutable fields
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.deliveryChannelName ?? (yield* createChannelName(id, news));
          const desired = toWireChannel(name, news);

          // 1. OBSERVE — cloud state is authoritative.
          const observed = yield* observeChannel(name);

          // 2+3. ENSURE + SYNC — PutDeliveryChannel is a full upsert; apply
          //    when missing or when any declared aspect drifted. Comparing
          //    the full wire shape is safe here: AWS echoes exactly the
          //    members that were put (no server-side defaults).
          const inSync =
            observed !== undefined &&
            observed.s3BucketName === desired.s3BucketName &&
            (observed.s3KeyPrefix ?? undefined) === desired.s3KeyPrefix &&
            (observed.s3KmsKeyArn ?? undefined) === desired.s3KmsKeyArn &&
            (observed.snsTopicARN ?? undefined) === desired.snsTopicARN &&
            (observed.configSnapshotDeliveryProperties?.deliveryFrequency ??
              undefined) ===
              desired.configSnapshotDeliveryProperties?.deliveryFrequency;
          if (!inSync) {
            yield* retryChannelPut(
              config.putDeliveryChannel({ DeliveryChannel: desired }),
            );
          }

          yield* session.note(name);
          return {
            deliveryChannelName: name,
            s3BucketName: news.s3BucketName,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryChannelDelete(
            config.deleteDeliveryChannel({
              DeliveryChannelName: output.deliveryChannelName,
            }),
          ).pipe(
            Effect.catchTag(
              "NoSuchDeliveryChannelException",
              () => Effect.void,
            ),
          );
        }),
      });
    }),
  );

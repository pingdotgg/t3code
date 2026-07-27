import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { syncManagedIntegrationsTags, toTagRecord } from "./internal.ts";

export interface DestinationProps {
  /**
   * Name of the destination. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing the name replaces the destination.
   */
  name?: string;
  /**
   * ARN of the delivery destination that receives events and notifications —
   * e.g. a Kinesis Data Stream ARN.
   */
  deliveryDestinationArn: string;
  /**
   * Type of the delivery destination.
   * @default "KINESIS"
   */
  deliveryDestinationType?: mi.DeliveryDestinationType;
  /**
   * ARN of the IAM role that grants Managed integrations permission to write
   * to the delivery destination.
   */
  roleArn: string;
  /**
   * Description of the destination.
   */
  description?: string;
  /**
   * User-defined tags to apply to the destination.
   */
  tags?: Record<string, string>;
}

export interface Destination extends Resource<
  "AWS.IoTManagedIntegrations.Destination",
  DestinationProps,
  {
    /** Name of the destination (its identifier). */
    destinationName: string;
    /** ARN of the delivery destination (e.g. Kinesis stream). */
    deliveryDestinationArn: string;
    /** Type of the delivery destination. */
    deliveryDestinationType: mi.DeliveryDestinationType;
    /** ARN of the IAM role used to deliver to the destination. */
    roleArn: string;
    /** Description of the destination. */
    description: string | undefined;
    /** Tags applied to the destination (user + internal). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT Managed Integrations notification destination. Managed
 * integrations delivers lifecycle events and device notifications to the
 * destination (currently a Kinesis Data Stream) using the provided IAM role.
 *
 * IoT Managed Integrations is a regional service available in a limited set
 * of regions (e.g. `eu-west-1`, `ca-central-1`).
 *
 * @resource
 * @section Creating Destinations
 * @example Kinesis Destination
 * ```typescript
 * const stream = yield* Kinesis.Stream("Events", {});
 * const role = yield* IAM.Role("DeliveryRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { Service: "iotmanagedintegrations.amazonaws.com" },
 *         Action: ["sts:AssumeRole"],
 *       },
 *     ],
 *   },
 * });
 * const destination = yield* Destination("EventDestination", {
 *   deliveryDestinationArn: stream.streamArn,
 *   roleArn: role.roleArn,
 *   description: "Managed integrations device events",
 * });
 * ```
 */
export const Destination = Resource<Destination>(
  "AWS.IoTManagedIntegrations.Destination",
);

export const DestinationProvider = () =>
  Provider.effect(
    Destination,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 128 });

      const observe = (name: string) =>
        mi
          .getDestination({ Name: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      // GetDestination does not return an ARN; the tag APIs need one, so
      // construct it from the ambient account/region.
      const destinationArn = Effect.fn(function* (name: string) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return `arn:aws:iotmanagedintegrations:${region}:${accountId}:destination/${name}`;
      });

      const toAttributes = Effect.fn(function* (
        destination: mi.GetDestinationResponse,
      ) {
        if (
          destination.Name === undefined ||
          destination.DeliveryDestinationArn === undefined ||
          destination.DeliveryDestinationType === undefined ||
          destination.RoleArn === undefined
        ) {
          return yield* Effect.fail(
            new Error("destination response is missing required fields"),
          );
        }
        return {
          destinationName: destination.Name,
          deliveryDestinationArn: destination.DeliveryDestinationArn,
          deliveryDestinationType: destination.DeliveryDestinationType,
          roleArn: destination.RoleArn,
          description: destination.Description,
          tags: toTagRecord(destination.Tags),
        };
      });

      return {
        stables: ["destinationName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.destinationName ?? (yield* toName(id, olds ?? {}));
          const destination = yield* observe(name);
          if (destination === undefined) return undefined;
          const attrs = yield* toAttributes(destination);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.destinationName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredType = news.deliveryDestinationType ?? "KINESIS";

          // Observe — cloud state is authoritative.
          let destination = yield* observe(name);

          // Ensure — create if missing; tolerate a concurrent-create race.
          if (destination === undefined) {
            yield* mi
              .createDestination({
                Name: name,
                DeliveryDestinationArn: news.deliveryDestinationArn,
                DeliveryDestinationType: desiredType,
                RoleArn: news.roleArn,
                Description: news.description,
                Tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            destination = yield* observe(name);
            if (destination === undefined) {
              return yield* Effect.fail(
                new Error(`destination '${name}' vanished after create`),
              );
            }
          }

          // Sync mutable settings — apply only the delta.
          if (
            destination.DeliveryDestinationArn !==
              news.deliveryDestinationArn ||
            destination.DeliveryDestinationType !== desiredType ||
            destination.RoleArn !== news.roleArn ||
            (destination.Description ?? undefined) !==
              (news.description ?? undefined)
          ) {
            yield* mi.updateDestination({
              Name: name,
              DeliveryDestinationArn: news.deliveryDestinationArn,
              DeliveryDestinationType: desiredType,
              RoleArn: news.roleArn,
              Description: news.description,
            });
          }

          // Sync tags — diff against OBSERVED cloud tags.
          yield* syncManagedIntegrationsTags(
            yield* destinationArn(name),
            toTagRecord(destination.Tags),
            desiredTags,
          );

          // Return fresh attributes.
          const final = yield* observe(name);
          if (final === undefined) {
            return yield* Effect.fail(
              new Error(`destination '${name}' vanished during reconcile`),
            );
          }
          const attrs = yield* toAttributes(final);
          yield* session.note(attrs.destinationName);
          return attrs;
        }),
        // Enumerate every destination in the account/region; fetch each one to
        // resolve its tags (summaries omit them).
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* mi.listDestinations.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
            const destinations = yield* Effect.forEach(
              summaries.filter(
                (s): s is mi.DestinationSummary & { Name: string } =>
                  s.Name !== undefined,
              ),
              (summary) => observe(summary.Name),
              { concurrency: 5 },
            );
            return yield* Effect.forEach(
              destinations.filter(
                (d): d is mi.GetDestinationResponse => d !== undefined,
              ),
              toAttributes,
            );
          }),
        delete: Effect.fn(function* ({ output }) {
          yield* mi
            .deleteDestination({ Name: output.destinationName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readIotWirelessTags, syncIotWirelessTags } from "./internal.ts";

export interface DestinationProps {
  /**
   * Name of the destination. Names are unique per account/region and may
   * contain only alphanumerics, dashes, and underscores. If omitted, a
   * deterministic physical name is generated. Changing the name replaces
   * the destination.
   */
  name?: string;
  /**
   * How `expression` is interpreted: `RuleName` routes uplinks to an AWS
   * IoT rule; `MqttTopic` publishes them to an MQTT topic.
   */
  expressionType: iotw.ExpressionType;
  /**
   * The IoT rule name or MQTT topic uplink messages are routed to. The
   * referenced rule does not need to exist when the destination is created.
   */
  expression: string;
  /**
   * Human-readable description of the destination.
   */
  description?: string;
  /**
   * ARN of the IAM role IoT Wireless assumes to deliver messages to the
   * rule or topic. The role's trust policy must allow
   * `iotwireless.amazonaws.com` to assume it.
   */
  roleArn: string;
  /**
   * Tags applied to the destination. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

export interface Destination extends Resource<
  "AWS.IoTWireless.Destination",
  DestinationProps,
  {
    /** Name of the destination (its unique identifier). */
    destinationName: string;
    /** ARN of the destination. */
    destinationArn: string;
    /** How the expression is interpreted (`RuleName` or `MqttTopic`). */
    expressionType: iotw.ExpressionType;
    /** The IoT rule name or MQTT topic uplinks are routed to. */
    expression: string;
    /** ARN of the delivery IAM role. */
    roleArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT Core for LoRaWAN destination — the routing rule that delivers
 * uplink messages from wireless devices to an AWS IoT rule or MQTT topic.
 *
 * The destination name is its identity (changing it replaces the
 * destination); the expression, expression type, description, role, and
 * tags all update in place.
 * @resource
 * @section Creating Destinations
 * @example Route uplinks to an IoT rule
 * ```typescript
 * import * as IoTWireless from "alchemy/AWS/IoTWireless";
 *
 * const destination = yield* IoTWireless.Destination("Uplinks", {
 *   expressionType: "RuleName",
 *   expression: "process_sensor_uplinks",
 *   roleArn: deliveryRole.roleArn,
 * });
 * ```
 *
 * @example Publish uplinks straight to an MQTT topic
 * ```typescript
 * const destination = yield* IoTWireless.Destination("Uplinks", {
 *   expressionType: "MqttTopic",
 *   expression: "sensors/uplinks",
 *   roleArn: deliveryRole.roleArn,
 * });
 * ```
 *
 * @section Delivery Role
 * @example IAM role IoT Wireless assumes for delivery
 * ```typescript
 * const deliveryRole = yield* IAM.Role("IotWirelessDelivery", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { Service: "iotwireless.amazonaws.com" },
 *       Action: ["sts:AssumeRole"],
 *     }],
 *   },
 *   policies: [{
 *     policyName: "deliver",
 *     policyDocument: {
 *       Version: "2012-10-17",
 *       Statement: [{
 *         Effect: "Allow",
 *         Action: ["iot:DescribeEndpoint", "iot:Publish"],
 *         Resource: ["*"],
 *       }],
 *     },
 *   }],
 * });
 * ```
 *
 * @section Consuming Uplinks in a Function
 * Uplinks are delivered through AWS IoT Core. For a `RuleName` destination,
 * `IoTWireless.consumeUplinks` (see {@link DestinationEventSource}) creates
 * the named IoT rule targeting the current Lambda and invokes the handler
 * for every uplink. Alternatively, point an `MqttTopic` destination at a
 * topic and consume it with `AWS.IoT.consumeTopicMessages`.
 * @example Route Device Uplinks into a Lambda
 * ```typescript
 * const destination = yield* IoTWireless.Destination("Uplinks", {
 *   expressionType: "RuleName",
 *   expression: "sensor_uplinks",
 *   roleArn: deliveryRole.roleArn,
 * });
 *
 * // inside the Function effect (provide Lambda.WirelessDestinationEventSource):
 * yield* IoTWireless.consumeUplinks(destination, (uplinks) =>
 *   uplinks.pipe(
 *     Stream.runForEach((uplink) => processUplink(uplink)),
 *     Effect.orDie,
 *   ),
 * );
 * ```
 */
export const Destination = Resource<Destination>("AWS.IoTWireless.Destination");

export const DestinationProvider = () =>
  Provider.effect(
    Destination,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string },
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const getDestination = (name: string) =>
        iotw
          .getDestination({ Name: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const toAttrs = Effect.fn(function* (
        destination: iotw.GetDestinationResponse,
        name: string,
      ) {
        if (destination.Arn === undefined) {
          return yield* Effect.fail(
            new Error(
              `IoT Wireless destination '${name}' returned without Arn`,
            ),
          );
        }
        return {
          destinationName: destination.Name ?? name,
          destinationArn: destination.Arn,
          expressionType: destination.ExpressionType ?? "RuleName",
          expression: destination.Expression ?? "",
          roleArn: destination.RoleArn ?? "",
        };
      });

      return Destination.Provider.of({
        stables: ["destinationName", "destinationArn"],

        list: () =>
          iotw.listDestinations.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.DestinationList ?? [])
                .flatMap((d) =>
                  d.Name !== undefined && d.Arn !== undefined
                    ? [
                        {
                          destinationName: d.Name,
                          destinationArn: d.Arn,
                          expressionType: d.ExpressionType ?? "RuleName",
                          expression: d.Expression ?? "",
                          roleArn: d.RoleArn ?? "",
                        },
                      ]
                    : [],
                ),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.destinationName ?? (yield* createName(id, olds ?? {}));
          const destination = yield* getDestination(name);
          if (destination === undefined) return undefined;
          const attrs = yield* toAttrs(destination, name);
          const tags = yield* readIotWirelessTags(attrs.destinationArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // The name is the destination's identity — changing it replaces the
        // resource. Everything else updates in place via UpdateDestination.
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.destinationName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          let destination = yield* getDestination(name);

          // 2. ENSURE — create if missing; a Conflict means a peer created
          //    it concurrently, so fall through to the sync step.
          if (destination === undefined) {
            yield* session.note(`creating destination ${name}`);
            yield* iotw
              .createDestination({
                Name: name,
                ExpressionType: news.expressionType,
                Expression: news.expression,
                Description: news.description,
                RoleArn: news.roleArn,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.asVoid,
                Effect.catchTag("ConflictException", () => Effect.void),
              );
            destination = yield* getDestination(name);
          }
          if (destination === undefined) {
            return yield* Effect.fail(
              new Error(
                `IoT Wireless destination '${name}' not found after create`,
              ),
            );
          }

          // 3. SYNC — apply the expression/description/role delta from
          //    OBSERVED state; skip the API call entirely on no-op.
          const expressionDelta =
            destination.Expression !== news.expression ||
            destination.ExpressionType !== news.expressionType;
          const descriptionDelta =
            news.description !== undefined &&
            destination.Description !== news.description;
          const roleDelta = destination.RoleArn !== news.roleArn;
          if (expressionDelta || descriptionDelta || roleDelta) {
            yield* iotw.updateDestination({
              Name: name,
              ExpressionType: news.expressionType,
              Expression: news.expression,
              Description: news.description,
              RoleArn: news.roleArn,
            });
            destination = yield* getDestination(name);
          }
          if (destination === undefined) {
            return yield* Effect.fail(
              new Error(
                `IoT Wireless destination '${name}' vanished during update`,
              ),
            );
          }

          // 3b. SYNC tags — diff against OBSERVED cloud tags.
          const attrs = yield* toAttrs(destination, name);
          yield* syncIotWirelessTags(attrs.destinationArn, desiredTags);

          yield* session.note(attrs.destinationArn);
          return attrs;
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* iotw.deleteDestination({ Name: output.destinationName }).pipe(
            Effect.asVoid,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );

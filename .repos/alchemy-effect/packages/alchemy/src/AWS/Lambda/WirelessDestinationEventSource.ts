import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Namespace from "../../Namespace.ts";
import { TopicRule } from "../IoT/TopicRule.ts";
import type { Destination } from "../IoTWireless/Destination.ts";
import {
  DestinationEventSource as IoTWirelessDestinationEventSource,
  type DestinationEventSourceService,
  type WirelessUplinkHandlerFn,
  type WirelessUplinkMessage,
} from "../IoTWireless/DestinationEventSource.ts";
import * as Lambda from "./Function.ts";
import { Permission as LambdaPermission } from "./Permission.ts";

/**
 * An IoT Wireless uplink invocation — the envelope IoT Core for LoRaWAN
 * delivers to a destination's rule: the base64 `PayloadData` plus the
 * sending device's id.
 */
export const isWirelessUplinkMessage = (
  event: any,
): event is WirelessUplinkMessage =>
  event != null &&
  typeof event === "object" &&
  typeof event.WirelessDeviceId === "string" &&
  typeof event.PayloadData === "string";

/**
 * Connects an IoT Wireless {@link Destination}'s uplink traffic to the
 * current Lambda function.
 *
 * At deploy time this layer creates the IoT topic rule named by the
 * destination's `expression` (the destination must use
 * `expressionType: "RuleName"`) with a Lambda action targeting this
 * function, and grants `iot.amazonaws.com` permission to invoke it; at
 * runtime it dispatches uplink invocations to the registered handler.
 * @binding
 * @section Consuming wireless uplinks
 * @example Consume LoRaWAN uplinks
 * ```typescript
 * yield* IoTWireless.consumeUplinks(destination, (uplinks) =>
 *   uplinks.pipe(
 *     Stream.runForEach((uplink) => Effect.log(uplink.PayloadData)),
 *     Effect.orDie,
 *   ),
 * );
 * ```
 */
export const WirelessDestinationEventSource = Layer.effect(
  IoTWirelessDestinationEventSource,
  // @effect-diagnostics-next-line missingEffectContext:off
  Effect.gen(function* () {
    // this layer can only be used in a Lambda Function
    const host = yield* Lambda.Function;
    const Rule = yield* TopicRule;
    const Permission = yield* LambdaPermission;

    return Effect.fn(function* <Req = never>(
      destination: Destination,
      process: WirelessUplinkHandlerFn<Req>,
    ) {
      // Deploy-time: create the IoT topic rule the destination's expression
      // names, with a Lambda action targeting this function, and grant
      // iot.amazonaws.com permission to invoke it (scoped to the rule ARN).
      // IoT Wireless invokes the rule directly by name, so the SQL FROM
      // clause is never matched against a real topic. Skipped once running
      // inside the deployed function, where the only work is registering
      // the runtime handler.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            const rule = yield* Rule(`${destination.LogicalId}-UplinkRule`, {
              ruleName: destination.expression,
              sql: "SELECT * FROM 'iotwireless/uplink'",
              actions: [{ lambda: { functionArn: host.functionArn } }],
            });

            yield* Permission(
              `AWS.IoTWireless.UplinkInvoke(${destination.LogicalId})`,
              {
                action: "lambda:InvokeFunction",
                functionName: host.functionName,
                principal: "iot.amazonaws.com",
                sourceArn: rule.ruleArn,
              },
            );
          }),
        );
      }

      yield* host.listen(
        Effect.gen(function* () {
          return (event: any) => {
            if (isWirelessUplinkMessage(event)) {
              return process(Stream.fromArray([event])).pipe(Effect.orDie);
            }
          };
        }),
      );
    }) as DestinationEventSourceService;
  }),
);

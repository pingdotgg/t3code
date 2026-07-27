import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { WirelessDevice } from "./WirelessDevice.ts";
import type { WirelessGateway } from "./WirelessGateway.ts";

/**
 * Shared HTTP scaffolding for the AWS IoT Wireless runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the IAM action, and the request
 * shaping is boilerplate.
 */

/**
 * Build the impl Effect for an IoT Wireless operation scoped to one
 * {@link WirelessDevice}: the deploy-time half grants `iamActions` on the
 * bound device's ARN, and the runtime half injects the device's
 * server-assigned id into every request via `prepare`.
 */
export const makeIotWirelessDeviceHttpBinding = <I, A, E, R, Req>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"SendDataToWirelessDevice"`.
   */
  capability: string;
  /** IAM actions granted on the bound device's ARN. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** Map the public request shape + bound device id onto the wire request. */
  prepare: (request: Req, wirelessDeviceId: string) => I;
  /**
   * IAM resource scope. Defaults to the bound device's ARN. The position
   * operations (`GetResourcePosition` / `UpdateResourcePosition`) must use
   * `"any"`: IoT Wireless authorizes them against a type-level ARN
   * (`…:WirelessDevice/WirelessDevice`, built from the `resourceType`
   * query parameter), which the device ARN never matches.
   */
  resourceScope?: "device" | "any";
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (device: WirelessDevice) {
      // Output yields a DEFERRED effect — resolve again per invocation below.
      const DeviceId = yield* device.wirelessDeviceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.IoTWireless.${options.capability}(${device}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource:
                    options.resourceScope === "any"
                      ? ["*"]
                      : [device.wirelessDeviceArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.IoTWireless.${options.capability}(${device.LogicalId})`,
      )(function* (request: Req) {
        const wirelessDeviceId = yield* DeviceId;
        return yield* op(options.prepare(request, wirelessDeviceId));
      });
    });
  });

/**
 * Build the impl Effect for an IoT Wireless operation scoped to one
 * {@link WirelessGateway}: the deploy-time half grants `iamActions` on the
 * bound gateway's ARN, and the runtime half injects the gateway's
 * server-assigned id into every request via `prepare`.
 */
export const makeIotWirelessGatewayHttpBinding = <I, A, E, R, Req>(options: {
  /** Short capability name used in the binding sid and runtime span. */
  capability: string;
  /** IAM actions granted on the bound gateway's ARN. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** Map the public request shape + bound gateway id onto the wire request. */
  prepare: (request: Req, wirelessGatewayId: string) => I;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (gateway: WirelessGateway) {
      const GatewayId = yield* gateway.wirelessGatewayId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.IoTWireless.${options.capability}(${gateway}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: [gateway.wirelessGatewayArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.IoTWireless.${options.capability}(${gateway.LogicalId})`,
      )(function* (request: Req) {
        const wirelessGatewayId = yield* GatewayId;
        return yield* op(options.prepare(request, wirelessGatewayId));
      });
    });
  });

/**
 * Build the impl Effect for an account-level IoT Wireless operation (e.g.
 * `GetServiceEndpoint` or `GetPositionEstimate`, which are not scoped to a
 * single resource). Grants `iamActions` on `Resource: ["*"]`.
 */
export const makeIotWirelessAccountHttpBinding = <I, A, E, R, Req>(options: {
  /** Short capability name used in the binding sid and runtime span. */
  capability: string;
  /** IAM actions granted on `Resource: ["*"]`. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** Map the public request shape onto the wire request. */
  prepare: (request: Req) => I;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.IoTWireless.${options.capability}())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.IoTWireless.${options.capability}`)(function* (
        request: Req,
      ) {
        return yield* op(options.prepare(request));
      });
    });
  });

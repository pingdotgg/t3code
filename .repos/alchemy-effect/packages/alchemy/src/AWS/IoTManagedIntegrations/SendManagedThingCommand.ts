import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ManagedThing } from "./ManagedThing.ts";

/**
 * `SendManagedThingCommand` request with `ManagedThingId` injected from the
 * bound managed thing.
 */
export interface SendManagedThingCommandRequest extends Omit<
  mi.SendManagedThingCommandRequest,
  "ManagedThingId"
> {}

/**
 * Runtime binding for the `SendManagedThingCommand` operation (IAM action
 * `iotmanagedintegrations:SendManagedThingCommand`), scoped to one
 * {@link ManagedThing}.
 *
 * Sends a command to the bound device using its Matter-derived capability
 * data model — the primary control-plane-to-device data path. Provide the
 * implementation with
 * `Effect.provide(AWS.IoTManagedIntegrations.SendManagedThingCommandHttp)`.
 *
 * @binding
 * @section Controlling Devices
 * @example Toggle a Device On
 * ```typescript
 * const sendCommand = yield* IoTManagedIntegrations.SendManagedThingCommand(thing);
 *
 * const { TraceId } = yield* sendCommand({
 *   Endpoints: [
 *     {
 *       endpointId: "1",
 *       capabilities: [
 *         {
 *           id: "aws.OnOff",
 *           name: "On/Off",
 *           version: "1",
 *           actions: [{ name: "activate", actionTraceId: "req-1" }],
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 */
export interface SendManagedThingCommand extends Binding.Service<
  SendManagedThingCommand,
  "AWS.IoTManagedIntegrations.SendManagedThingCommand",
  (
    thing: ManagedThing,
  ) => Effect.Effect<
    (
      request: SendManagedThingCommandRequest,
    ) => Effect.Effect<
      mi.SendManagedThingCommandResponse,
      mi.SendManagedThingCommandError
    >
  >
> {}
export const SendManagedThingCommand = Binding.Service<SendManagedThingCommand>(
  "AWS.IoTManagedIntegrations.SendManagedThingCommand",
);

import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link SendConnectorEvent}.
 */
export interface SendConnectorEventRequest
  extends mi.SendConnectorEventRequest {}

/**
 * Runtime binding for `iotmanagedintegrations:SendConnectorEvent`
 * (account-level).
 *
 * The cloud-to-cloud connector data plane: a connector Lambda calls this to
 * push third-party device events (state reports, discovery results, command
 * responses) into Managed integrations. Provide the implementation with
 * `Effect.provide(AWS.IoTManagedIntegrations.SendConnectorEventHttp)`.
 *
 * @binding
 * @section Connectors
 * @example Report a Device State Change from a Connector
 * ```typescript
 * const sendConnectorEvent = yield* IoTManagedIntegrations.SendConnectorEvent();
 *
 * yield* sendConnectorEvent({
 *   ConnectorId: connectorId,
 *   Operation: "DEVICE_EVENT",
 *   ConnectorDeviceId: "third-party-device-1",
 *   Devices: [
 *     {
 *       ConnectorDeviceId: "third-party-device-1",
 *       CapabilityReport: capabilityReport,
 *     },
 *   ],
 * });
 * ```
 */
export interface SendConnectorEvent extends Binding.Service<
  SendConnectorEvent,
  "AWS.IoTManagedIntegrations.SendConnectorEvent",
  () => Effect.Effect<
    (
      request: SendConnectorEventRequest,
    ) => Effect.Effect<
      mi.SendConnectorEventResponse,
      mi.SendConnectorEventError
    >
  >
> {}
export const SendConnectorEvent = Binding.Service<SendConnectorEvent>(
  "AWS.IoTManagedIntegrations.SendConnectorEvent",
);

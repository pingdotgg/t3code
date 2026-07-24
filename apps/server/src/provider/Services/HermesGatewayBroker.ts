import type {
  HermesGatewayConnectionHello,
  HermesGatewayCreateEnrollmentInput,
  HermesGatewayEnrollmentResult,
  HermesGatewayInstanceStatus,
  HermesGatewayPluginToT3Message,
  HermesGatewayRemoveInstanceResult,
  HermesGatewayRenameInstanceInput,
  HermesGatewayRenameInstanceResult,
  HermesGatewayRevokeInstanceResult,
  HermesGatewayT3ToPluginMessage,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { HermesGatewayManagementError } from "@t3tools/contracts";
import type { ProviderAdapterRequestError } from "../Errors.ts";

export interface HermesGatewayTransport {
  readonly send: (
    message: HermesGatewayT3ToPluginMessage,
  ) => Effect.Effect<void, ProviderAdapterRequestError>;
  readonly close: (code: number, reason: string) => Effect.Effect<void>;
}

export interface HermesGatewayConnectionRegistration {
  readonly instanceId: ProviderInstanceId;
  readonly generation: number;
  readonly accepted: Extract<
    HermesGatewayT3ToPluginMessage,
    { readonly type: "connection.accepted" }
  >;
}

export interface HermesGatewayEnvelope {
  readonly instanceId: ProviderInstanceId;
  readonly message: Exclude<HermesGatewayPluginToT3Message, HermesGatewayConnectionHello>;
}

export interface HermesGatewayBrokerShape {
  readonly createEnrollment: (
    input: HermesGatewayCreateEnrollmentInput,
  ) => Effect.Effect<HermesGatewayEnrollmentResult, HermesGatewayManagementError>;
  readonly getInstanceStatus: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<HermesGatewayInstanceStatus, HermesGatewayManagementError>;
  readonly listInstances: Effect.Effect<
    ReadonlyArray<HermesGatewayInstanceStatus>,
    HermesGatewayManagementError
  >;
  readonly renameInstance: (
    input: HermesGatewayRenameInstanceInput,
  ) => Effect.Effect<HermesGatewayRenameInstanceResult, HermesGatewayManagementError>;
  readonly revokeInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<HermesGatewayRevokeInstanceResult, HermesGatewayManagementError>;
  readonly removeInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<HermesGatewayRemoveInstanceResult, HermesGatewayManagementError>;
  readonly registerConnection: (
    hello: HermesGatewayConnectionHello,
    transport: HermesGatewayTransport,
  ) => Effect.Effect<
    HermesGatewayConnectionRegistration,
    Extract<HermesGatewayT3ToPluginMessage, { readonly type: "connection.rejected" }>
  >;
  readonly receive: (
    registration: HermesGatewayConnectionRegistration,
    message: Exclude<HermesGatewayPluginToT3Message, HermesGatewayConnectionHello>,
  ) => Effect.Effect<void>;
  readonly disconnect: (registration: HermesGatewayConnectionRegistration) => Effect.Effect<void>;
  readonly request: (
    instanceId: ProviderInstanceId,
    message: HermesGatewayT3ToPluginMessage,
  ) => Effect.Effect<
    Exclude<HermesGatewayPluginToT3Message, HermesGatewayConnectionHello>,
    ProviderAdapterRequestError
  >;
  readonly send: (
    instanceId: ProviderInstanceId,
    message: HermesGatewayT3ToPluginMessage,
  ) => Effect.Effect<void, ProviderAdapterRequestError>;
  readonly isConnected: (instanceId: ProviderInstanceId) => Effect.Effect<boolean>;
  readonly stream: Stream.Stream<HermesGatewayEnvelope>;
  readonly streamStatuses: Stream.Stream<HermesGatewayInstanceStatus>;
}

const unavailable = () => Effect.die(new Error("HermesGatewayBroker live layer is not installed"));

export const HermesGatewayBroker = Context.Reference<HermesGatewayBrokerShape>(
  "t3/provider/Services/HermesGatewayBroker",
  {
    defaultValue: () => ({
      createEnrollment: unavailable,
      getInstanceStatus: unavailable,
      listInstances: unavailable(),
      renameInstance: unavailable,
      revokeInstance: unavailable,
      removeInstance: unavailable,
      registerConnection: unavailable,
      receive: unavailable,
      disconnect: unavailable,
      request: unavailable,
      send: unavailable,
      isConnected: () => Effect.succeed(false),
      stream: Stream.empty,
      streamStatuses: Stream.empty,
    }),
  },
);

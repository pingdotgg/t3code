import {
  type DeviceActionInput,
  type DeviceCloseInput,
  type DeviceConfigureInput,
  type DeviceDetail,
  type DeviceDetailInput,
  type DeviceError,
  DeviceHostId,
  DeviceId,
  DeviceHostUnavailableError,
  DeviceNotFoundError,
  DeviceOperationError,
  type DeviceOpenInput,
  type DevicePlatform,
  DevicePlatformUnavailableError,
  type DeviceServiceState,
  type DeviceSession,
  type DeviceShutdownInput,
  type DeviceSummary,
  type DeviceEasAccount,
  DeviceEasAccountError,
  type DeviceEasAccountInput,
  type DeviceSimlockIdentity,
  DeviceSimlockIdentityError,
  type DeviceSimlockIdentityInput,
  type DeviceHostConfig,
  type EasDeviceHostConfig,
  type SimlockDeviceHostConfig,
  type SshDeviceHostConfig,
  type DeviceHostSummary,
  LOCAL_DEVICE_HOST_ID,
  LOCAL_DEVICE_HOST_LABEL,
  type ThreadId,
} from "@t3tools/contracts";
import { SshCommandError } from "@t3tools/ssh/errors";
import * as FileSystem from "effect/FileSystem";
import { resolveNodeExecutable, nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";
import * as Path from "effect/Path";
import { ensureAgentDevice, ensureDeviceHub } from "./DeviceToolchain.ts";
import {
  agentDeviceCloseOutcome,
  bindAgentDeviceLauncher,
  ensureAgentDeviceShim,
  pruneAgentDeviceLaunchers,
} from "./AgentDeviceShim.ts";
import * as ServerConfig from "../config.ts";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as HttpClient from "effect/http/HttpClient";

import * as ServerSettings from "../serverSettings.ts";
import { isLocalSshDeviceHost, remoteSshDeviceHosts } from "./localSshDeviceHost.ts";

import { readDeviceDetail, runDeviceAction } from "./DeviceActions.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as SshDeviceHost from "./SshDeviceHost.ts";
import * as EasDeviceHost from "./EasDeviceHost.ts";
import * as SimlockDeviceHost from "./SimlockDeviceHost.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeExpoApi } from "./ExpoApi.ts";
import * as Exit from "effect/Exit";
import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import { make } from "./DeviceServiceParts.ts";
import { sshProbeFailureMessage } from "./DeviceServiceParts2.ts";

import { makeDeviceState } from "./DeviceService-part3.ts";
import { makeDeviceStage2 } from "./DeviceService-part4.ts";
import { makeDeviceFlows } from "./DeviceService-part5.ts";

export const DEVICE_HUB_ROUTE_PREFIX = "/api/device-hub";

export interface DeviceScreenshot {
  readonly device: DeviceSummary;
  readonly png: Uint8Array;
}

export interface DeviceReadiness extends DeviceHost.DeviceHostReady {
  readonly hostId: DeviceHostId;
}

export interface DeviceAgentReadiness extends DeviceReadiness {
  /** Null when each device has its own daemon; see `DeviceOperations.agentEndpoint`. */
  readonly agentDevice: DeviceHost.AgentDeviceEndpoint | null;
}

const DeviceHostName = Schema.Struct({ id: DeviceHostId, label: Schema.optional(Schema.String) });
const hostName = (host: typeof DeviceHostName.Type) => host.label ?? `host ${host.id}`;

export class DeviceHostAmbiguousError extends Schema.TaggedError<DeviceHostAmbiguousError>()(
  "DeviceHostAmbiguousError",
  { deviceId: DeviceId, hosts: Schema.Array(DeviceHostName) },
) {
  override get message(): string {
    return `Device ${this.deviceId} is on more than one host: ${this.hosts.map(hostName).join(", ")}.`;
  }
}

export class DeviceOnOtherHostError extends Schema.TaggedError<DeviceOnOtherHostError>()(
  "DeviceOnOtherHostError",
  { deviceId: DeviceId, host: DeviceHostName, hosts: Schema.Array(DeviceHostName) },
) {
  override get message(): string {
    return `Device ${this.deviceId} is not on ${hostName(this.host)}. It is on ${this.hosts.map(hostName).join(", ")}.`;
  }
}

export class DeviceService extends Context.Service<
  DeviceService,
  {
    readonly testHost: (
      config: SshDeviceHostConfig,
    ) => Effect.Effect<DeviceHostSummary, DeviceError>;
    /** Who an Expo credential signs in as and which EAS projects it can run sessions under. */
    readonly easAccount: (
      input: DeviceEasAccountInput,
    ) => Effect.Effect<DeviceEasAccount, DeviceEasAccountError>;
    /** Who a Simlock agent token is; without a gateway or token, this machine's agent-device's. */
    readonly simlockIdentity: (
      input: DeviceSimlockIdentityInput,
    ) => Effect.Effect<DeviceSimlockIdentity, DeviceSimlockIdentityError>;
    /**
     * The agent-device flags that reach the device: its config and session,
     * and the id agent-device selects it by, which can differ from its id here.
     */
    readonly agentTarget: (input: {
      threadId: ThreadId;
      hostId: DeviceHostId;
      deviceId: DeviceId;
    }) => Effect.Effect<
      {
        readonly agentDeviceId: string | null;
        readonly session: string;
        readonly args: ReadonlyArray<string>;
        readonly installDirectory?: string | undefined;
      },
      DeviceError
    >;
    /**
     * The command agents run for one agent-device session; it is removed when the session ends.
     * None when the session closed before it could be bound.
     */
    readonly agentLauncher: (input: {
      readonly threadId: ThreadId;
      readonly hostId: DeviceHostId;
      readonly deviceId: DeviceId;
      readonly targetArgs: ReadonlyArray<string>;
    }) => Effect.Effect<Option.Option<string>, DeviceError>;
    readonly state: Effect.Effect<DeviceServiceState>;
    readonly subscribe: Effect.Effect<PubSub.Subscription<DeviceServiceState>, never, Scope.Scope>;
    readonly configure: (
      input: DeviceConfigureInput,
    ) => Effect.Effect<DeviceServiceState, DeviceError>;
    readonly list: Effect.Effect<DeviceServiceState, DeviceError>;
    readonly updateTool: (tool: "hub" | "agent") => Effect.Effect<DeviceServiceState, DeviceError>;
    readonly inspect: Effect.Effect<DeviceServiceState>;
    readonly retryHost: (hostId: DeviceHostId) => Effect.Effect<DeviceServiceState, DeviceError>;
    readonly open: (
      input: DeviceOpenInput,
      context?: DeviceHost.DeviceOpenContext,
    ) => Effect.Effect<DeviceSession, DeviceError>;
    readonly close: (input: DeviceCloseInput) => Effect.Effect<void, DeviceError>;
    readonly shutdown: (input: DeviceShutdownInput) => Effect.Effect<void, DeviceError>;
    readonly detail: (input: DeviceDetailInput) => Effect.Effect<DeviceDetail, DeviceError>;
    readonly action: (input: DeviceActionInput) => Effect.Effect<DeviceDetail, DeviceError>;
    readonly screenshot: (input: {
      readonly hostId?: DeviceHostId | undefined;
      readonly deviceId: DeviceId;
    }) => Effect.Effect<DeviceScreenshot, DeviceError>;
    /**
     * The device an id names in the last listing. Ids are unique per host, not across hosts (an
     * Android AVD name can exist on two), so a hostId decides, and without one the id has to be
     * on a single host.
     */
    readonly locateDevice: (input: {
      readonly hostId?: DeviceHostId | undefined;
      readonly deviceId: DeviceId;
    }) => Effect.Effect<
      Option.Option<DeviceSummary>,
      DeviceHostAmbiguousError | DeviceOnOtherHostError
    >;
    /** As `locateDevice`, among the devices a thread has open. */
    readonly locateSession: (input: {
      readonly threadId: ThreadId;
      readonly hostId?: DeviceHostId | undefined;
      readonly deviceId: DeviceId;
    }) => Effect.Effect<
      Option.Option<DeviceSession>,
      DeviceHostAmbiguousError | DeviceOnOtherHostError
    >;
    readonly readiness: (hostId?: DeviceHostId) => Effect.Effect<DeviceReadiness, DeviceError>;
    readonly readinessIfSupported: (
      hostId?: DeviceHostId,
    ) => Effect.Effect<DeviceReadiness | null, DeviceError>;
    readonly agentReadinessIfSupported: (
      hostId?: DeviceHostId,
    ) => Effect.Effect<DeviceAgentReadiness | null, DeviceError>;
    readonly currentReadiness: (hostId?: DeviceHostId) => Effect.Effect<DeviceReadiness | null>;
    readonly sessionsForThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<DeviceSession>>;
  }
>()("t3/device/DeviceService") {}

export interface ServiceState {
  readonly state: DeviceServiceState;
}

export interface AgentDeviceLaunchers {
  readonly bind: (input: {
    readonly session: string;
    readonly targetArgs: ReadonlyArray<string>;
  }) => Effect.Effect<string, DeviceError>;
  /** Removes every launcher whose session is not in `live`. */
  readonly prune: (live: ReadonlySet<string>) => Effect.Effect<void>;
  /** Ends the agent-device session behind a launcher, which releases its claim on the device. */
  readonly release?: (launcher: string) => Effect.Effect<void>;
}

export const makeWithHosts = Effect.fn("DeviceService.makeWithHosts")(function* (
  hosts: ReadonlyMap<DeviceHostId, DeviceHost.DeviceHost["Service"]>,
  testHost: DeviceService["Service"]["testHost"] = (host) =>
    Effect.fail(
      new DeviceHostUnavailableError({
        hostId: host.id,
        hostLabel: host.label,
        reason: "SSH probing is unavailable in this device service.",
      }),
    ),
  configureAgent: (
    hostId: DeviceHostId,
    endpoint: DeviceHost.AgentDaemonEndpoint & { readonly stateDir?: string | undefined },
    deviceId?: DeviceId,
  ) => Effect.Effect<string, DeviceError> = (hostId) =>
    Effect.fail(
      new DeviceHostUnavailableError({
        hostId,
        reason: "Agent configuration is unavailable in this device service.",
      }),
    ),
  installTool?: (tool: "hub" | "agent") => Effect.Effect<unknown, DeviceError>,
  launchers?: AgentDeviceLaunchers,
) {
  const s1 = yield* makeDeviceState(hosts, testHost, configureAgent, installTool, launchers);
  const s2 = yield* makeDeviceStage2(s1);
  const s3 = yield* makeDeviceFlows(s2);
  const shape = s3;
  return shape;
});

/** @public */
/** @public */
export const layer = Layer.effect(DeviceService, make).pipe(
  Layer.provide(LocalDeviceHost.layer),
  Layer.provide(SecretResolverLayer.layer),
);

export const stateStream = (service: DeviceService["Service"]): Stream.Stream<DeviceServiceState> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before reading so no change is lost.
      const subscription = yield* service.subscribe;
      const initial = yield* service.state;
      return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
    }),
  ).pipe(Stream.scoped);
export * from "./DeviceServiceParts.ts";


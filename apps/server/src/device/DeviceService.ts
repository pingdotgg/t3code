import {
  type DeviceActionInput,
  type DeviceCloseInput,
  type DeviceConfigureInput,
  type DeviceDetail,
  type DeviceDetailInput,
  type DeviceError,
  type DeviceHostId,
  type DeviceId,
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
  type DeviceHostConfig,
  type EasDeviceHostConfig,
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
import * as ServerConfig from "../config.ts";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as HttpClient from "effect/http/HttpClient";

import * as ServerSettings from "../serverSettings.ts";
import { isLocalSshDeviceHost, remoteSshDeviceHosts } from "./localSshDeviceHost.ts";

import { readDeviceDetail, runDeviceAction } from "./DeviceActions.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as SshDeviceHost from "./SshDeviceHost.ts";
import * as EasDeviceHost from "./EasDeviceHost.ts";
import { makeExpoApi, resolveExpoCredential } from "./ExpoApi.ts";
import * as Exit from "effect/Exit";
import * as LocalDeviceHost from "./LocalDeviceHost.ts";

export const DEVICE_HUB_ROUTE_PREFIX = "/api/device-hub";

const sshProbeFailureMessage = (error: DeviceHost.DeviceHostError): string => {
  const cause = error.cause;
  if (
    !(cause instanceof SshCommandError) ||
    cause.exitCode === null ||
    cause.exitCode < 1 ||
    cause.exitCode > 254
  )
    return "Could not connect to this host over SSH.";

  // Only the known bootstrap diagnostic is safe to expose as Node guidance.
  if (
    cause.exitCode === 1 &&
    cause.stderr
      .split(/\r?\n/u)
      .some((line) => line.trim() === "Node is missing from the non-interactive SSH PATH")
  )
    return "Connected over SSH, but Node is not on this host's PATH for non-interactive SSH commands.";

  return `Connected over SSH, but the device host check failed (exit code ${cause.exitCode}).`;
};

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

export class DeviceService extends Context.Service<
  DeviceService,
  {
    readonly agentCli: Effect.Effect<string, DeviceError>;
    readonly testHost: (
      config: SshDeviceHostConfig,
    ) => Effect.Effect<DeviceHostSummary, DeviceError>;
    /** Who an Expo credential signs in as and which EAS projects it can run sessions under. */
    readonly easAccount: (
      input: DeviceEasAccountInput,
    ) => Effect.Effect<DeviceEasAccount, DeviceEasAccountError>;
    /**
     * The agent-device flags that reach the device: its config and session,
     * and the id agent-device selects it by, which can differ from its id here.
     */
    readonly agentTarget: (input: {
      threadId: ThreadId;
      hostId: DeviceHostId;
      deviceId: DeviceId;
    }) => Effect.Effect<
      { readonly agentDeviceId: string; readonly args: ReadonlyArray<string> },
      DeviceError
    >;
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

interface ServiceState {
  readonly state: DeviceServiceState;
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
    endpoint: DeviceHost.AgentDaemonEndpoint,
    deviceId?: DeviceId,
  ) => Effect.Effect<string, DeviceError> = (hostId) =>
    Effect.fail(
      new DeviceHostUnavailableError({
        hostId,
        reason: "Agent configuration is unavailable in this device service.",
      }),
    ),
  installTool?: (tool: "hub" | "agent") => Effect.Effect<unknown, DeviceError>,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const lifecycleLock = yield* Semaphore.make(1);
  const readDeviceSettings = settings.getSettings.pipe(
    Effect.map((value) => ({
      enabled: value.enableDeviceSupport,
      agentAccessEnabled: value.enableAgentDeviceAccess,
      onboardingCompleted: value.deviceOnboardingCompleted,
    })),
    Effect.mapError(
      (cause) =>
        new DeviceOperationError({ operation: "settings", reason: "settings_failed", cause }),
    ),
  );
  const initialSettings = yield* readDeviceSettings;

  const statePubSub = yield* PubSub.unbounded<DeviceServiceState>();
  const initialHosts = yield* Effect.forEach(hosts.values(), (host) => host.summary);
  let publishedHosts = new Map(hosts);
  const stateRef = yield* SynchronizedRef.make<ServiceState>({
    state: {
      supportsHostRetry: true,
      supportsToolUpdate: installTool !== undefined,
      supportsToolInspection: true,
      supportsEasHosts: true,
      hosts: initialHosts,
      hostStatus: initialSettings.enabled ? "idle" : "disabled",
      hostStatuses: {},
      devices: [],
      sessions: [],
      onboardingCompleted: initialSettings.onboardingCompleted,
      agentAccessEnabled: initialSettings.agentAccessEnabled,
      hubBasePath: DEVICE_HUB_ROUTE_PREFIX,
      revision: 0,
    },
  });

  const publish = (update: (state: DeviceServiceState) => DeviceServiceState) =>
    SynchronizedRef.updateAndGetEffect(stateRef, ({ state }) => {
      const next = { ...update(state), revision: state.revision + 1 };
      return PubSub.publish(statePubSub, next).pipe(Effect.as({ state: next }));
    }).pipe(Effect.map(({ state }) => state));

  const resolveHost = Effect.fn("DeviceService.resolveHost")(function* (
    hostId: DeviceHostId | undefined,
  ) {
    const id = hostId ?? LOCAL_DEVICE_HOST_ID;
    const host = hosts.get(id);
    if (!host) {
      return yield* new DeviceHostUnavailableError({ hostId: id, reason: "Unknown host." });
    }
    return host;
  });

  const setHostStatus = (
    hostId: DeviceHostId,
    status: DeviceServiceState["hostStatuses"][string],
  ) =>
    Effect.suspend(() =>
      !hosts.has(hostId)
        ? SynchronizedRef.get(stateRef).pipe(Effect.map(({ state }) => state))
        : publish((state) => ({
            ...state,
            ...(hostId === LOCAL_DEVICE_HOST_ID
              ? { hostStatus: status.status, hostStatusDetail: status.detail }
              : {}),
            hostStatuses: {
              ...state.hostStatuses,
              [hostId]: {
                ...(state.hostStatuses[hostId]?.androidDiscoveryIncomplete
                  ? { androidDiscoveryIncomplete: true }
                  : {}),
                ...status,
              },
            },
          })),
    );

  const readiness: DeviceService["Service"]["readiness"] = Effect.fn("DeviceService.readiness")(
    function* (hostId) {
      const host = yield* resolveHost(hostId);
      if (!(yield* readDeviceSettings).enabled) {
        return yield* new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason:
            "Device support is off. Enable it in the Device panel before installing or starting device tools.",
        });
      }
      const ready = yield* host
        .ensureReady((status, detail) =>
          setHostStatus(host.id, { status, detail }).pipe(Effect.asVoid),
        )
        .pipe(
          Effect.tapError((error) =>
            setHostStatus(host.id, {
              status: "failed",
              detail:
                error._tag === "DeviceHostError" && error.step === "probe"
                  ? sshProbeFailureMessage(error)
                  : error.message,
            }),
          ),
          Effect.mapError(
            (error) =>
              new DeviceHostUnavailableError({
                hostId: host.id,
                hostLabel: host.label,
                reason:
                  error._tag === "NodeRuntimeUnavailableError"
                    ? nodeRuntimeUnavailableMessage("Local device support")
                    : error.step === "probe"
                      ? sshProbeFailureMessage(error)
                      : `Device support failed during ${error.step}.`,
                cause: error,
              }),
          ),
        );
      if (hosts.get(host.id) !== host)
        return yield* new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: "Host configuration changed. Retry the operation.",
        });
      const { state } = yield* SynchronizedRef.get(stateRef);
      if (state.hostStatuses[host.id]?.status !== "ready") {
        yield* setHostStatus(host.id, { status: "ready" });
      }
      return { hostId: host.id, ...ready };
    },
    lifecycleLock.withPermit,
  );

  const readinessIfSupported: DeviceService["Service"]["readinessIfSupported"] = Effect.fn(
    "DeviceService.readinessIfSupported",
  )(function* (hostId) {
    if (!(yield* readDeviceSettings).enabled) return null;
    const host = yield* resolveHost(hostId);
    const summary = yield* host.summary;
    if (summary.kind === "local" && !summary.platforms.some((platform) => platform.available))
      return null;
    return yield* readiness(host.id);
  });

  const agentReadinessIfSupported: DeviceService["Service"]["agentReadinessIfSupported"] =
    Effect.fn("DeviceService.agentReadinessIfSupported")(function* (hostId) {
      const deviceSettings = yield* readDeviceSettings;
      if (!deviceSettings.enabled || !deviceSettings.agentAccessEnabled) return null;
      const host = yield* resolveHost(hostId);
      const summary = yield* host.summary;
      if (summary.kind === "local" && !summary.platforms.some((platform) => platform.available))
        return null;
      const ready = yield* host
        .ensureAgentReady((phase, detail) =>
          setHostStatus(host.id, { status: phase, detail }).pipe(Effect.asVoid),
        )
        .pipe(
          Effect.tapError((error) =>
            setHostStatus(host.id, {
              status: "failed",
              detail:
                error._tag === "DeviceHostError" && error.step === "probe"
                  ? sshProbeFailureMessage(error)
                  : error.message,
            }),
          ),
          Effect.mapError(
            (error) =>
              new DeviceHostUnavailableError({
                hostId: host.id,
                hostLabel: host.label,
                reason:
                  error._tag === "NodeRuntimeUnavailableError"
                    ? nodeRuntimeUnavailableMessage("Local device support")
                    : error._tag === "DeviceHostTimeoutError"
                      ? `Agent tools did not start within ${error.timeoutMs} ms.`
                      : error._tag === "AgentDeviceStartError"
                        ? error.message
                        : error.step === "probe"
                          ? sshProbeFailureMessage(error)
                          : `Device support failed during ${error.step}.`,
                cause: error,
              }),
          ),
        );
      const hostSummaries = yield* Effect.forEach(hosts.values(), (candidate) => candidate.summary);
      yield* publish((state) => ({ ...state, hosts: hostSummaries }));
      yield* setHostStatus(host.id, { status: "ready" });
      return { hostId: host.id, ...ready };
    }, lifecycleLock.withPermit);

  const currentReadiness: DeviceService["Service"]["currentReadiness"] = (hostId) =>
    resolveHost(hostId).pipe(
      Effect.flatMap((host) =>
        host.current.pipe(Effect.map((ready) => (ready ? { hostId: host.id, ...ready } : null))),
      ),
      Effect.orElseSucceed(() => null),
    );

  const fetchDevices = Effect.fn("DeviceService.fetchDevices")(function* (ready: DeviceReadiness) {
    const { devices, detail, androidDiscoveryIncomplete } = yield* ready.devices.list;
    return {
      devices: devices.map((device): DeviceSummary => ({ ...device, hostId: ready.hostId })),
      detail,
      androidDiscoveryIncomplete,
    };
  });

  const refresh = Effect.fn("DeviceService.refresh")(function* (ready: DeviceReadiness) {
    const host = hosts.get(ready.hostId);
    // A session opened while the listing ran is on a device the listing could
    // not have seen yet; only sessions from before it can be pruned by it.
    const sessionKey = (session: DeviceSession) =>
      `${session.hostId}\u0000${session.deviceId}\u0000${session.threadId}\u0000${session.openedAt}`;
    const before = new Set((yield* SynchronizedRef.get(stateRef)).state.sessions.map(sessionKey));
    const { devices, detail, androidDiscoveryIncomplete } = yield* fetchDevices(ready);
    const hostSummaries = yield* Effect.forEach(hosts.values(), (host) => host.summary);
    return yield* lifecycleLock.withPermit(
      Effect.gen(function* () {
        if (!(yield* readDeviceSettings).enabled || !host || hosts.get(ready.hostId) !== host)
          return (yield* SynchronizedRef.get(stateRef)).state;
        return yield* publish((state) => ({
          ...state,
          hosts: hostSummaries,
          ...(ready.hostId === LOCAL_DEVICE_HOST_ID ? { hostStatusDetail: detail } : {}),
          devices: [
            ...state.devices.filter((device) => device.hostId !== ready.hostId),
            ...devices,
          ],
          // A host that ends devices itself (EAS stops sessions at their limits)
          // leaves sessions on devices it no longer lists with nothing to stream.
          // Other hosts can miss a device for one listing, so theirs stay.
          sessions: ready.devices.endsDevices
            ? state.sessions.filter(
                (session) =>
                  session.hostId !== ready.hostId ||
                  !before.has(sessionKey(session)) ||
                  devices.some((device) => device.id === session.deviceId),
              )
            : state.sessions,
          hostStatuses: {
            ...state.hostStatuses,
            [ready.hostId]: {
              status: "ready",
              ...(detail ? { detail } : {}),
              ...(androidDiscoveryIncomplete ? { androidDiscoveryIncomplete } : {}),
            },
          },
        }));
      }),
    );
  });

  const list: DeviceService["Service"]["list"] = Effect.gen(function* () {
    if (!(yield* readDeviceSettings).enabled) return (yield* SynchronizedRef.get(stateRef)).state;
    yield* Effect.forEach(
      hosts.values(),
      (host) =>
        Effect.gen(function* () {
          const ready = yield* readinessIfSupported(host.id);
          if (ready) yield* refresh(ready);
        }).pipe(
          Effect.catch((error) =>
            setHostStatus(host.id, {
              status: "failed",
              detail: error._tag === "DeviceHostUnavailableError" ? error.reason : error.message,
            }),
          ),
        ),
      { concurrency: 4 },
    );
    return (yield* SynchronizedRef.get(stateRef)).state;
  }).pipe(Effect.withSpan("DeviceService.list"));

  const inspect = Effect.gen(function* () {
    yield* Effect.forEach(
      hosts.values(),
      (host) =>
        Effect.gen(function* () {
          const result = yield* (host.inspect ?? host.summary).pipe(Effect.result);
          if (hosts.get(host.id) !== host) return;
          if (result._tag === "Failure") {
            yield* publish((state) => ({
              ...state,
              hosts: state.hosts.map((value) =>
                value.id === host.id
                  ? {
                      ...value,
                      toolInspectionError:
                        "Cannot check versions. Reconnect the host and check again. Installed tools have not been changed.",
                    }
                  : value,
              ),
            }));
            return;
          }
          yield* publish((state) => ({
            ...state,
            hosts: state.hosts.map((value) => (value.id === host.id ? result.success : value)),
          }));
        }),
      { concurrency: 4 },
    );
    return (yield* SynchronizedRef.get(stateRef)).state;
  });

  const retryHost: DeviceService["Service"]["retryHost"] = Effect.fn("DeviceService.retryHost")(
    function* (hostId) {
      yield* resolveHost(hostId);
      if (!(yield* readDeviceSettings).enabled) return (yield* SynchronizedRef.get(stateRef)).state;
      yield* Effect.gen(function* () {
        const ready =
          (yield* agentReadinessIfSupported(hostId)) ?? (yield* readinessIfSupported(hostId));
        if (ready) yield* refresh(ready);
      }).pipe(
        Effect.catch((error) =>
          setHostStatus(hostId, {
            status: "failed",
            detail: error._tag === "DeviceHostUnavailableError" ? error.reason : error.message,
          }),
        ),
      );
      return (yield* SynchronizedRef.get(stateRef)).state;
    },
  );

  const configure: DeviceService["Service"]["configure"] = Effect.fn("DeviceService.configure")(
    function* (input) {
      const currentSettings = yield* readDeviceSettings;
      const nextEnabled = input.enabled ?? currentSettings.enabled;
      const nextAgentAccess = input.agentAccessEnabled ?? currentSettings.agentAccessEnabled;
      yield* lifecycleLock.withPermit(
        Effect.gen(function* () {
          yield* settings
            .updateSettings({
              ...(input.enabled === undefined ? {} : { enableDeviceSupport: input.enabled }),
              ...(input.agentAccessEnabled === undefined
                ? {}
                : { enableAgentDeviceAccess: input.agentAccessEnabled }),
              ...(input.onboardingCompleted === undefined
                ? {}
                : { deviceOnboardingCompleted: input.onboardingCompleted }),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new DeviceOperationError({
                    operation: "configure",
                    reason: "settings_failed",
                    cause,
                  }),
              ),
            );
          if (!nextEnabled) {
            yield* Effect.forEach(hosts.values(), (host) => host.stop, { discard: true });
          } else if (input.agentAccessEnabled === false) {
            yield* Effect.forEach(hosts.values(), (host) => host.stopAgent, { discard: true });
          }
          yield* publish((state) => ({
            ...state,
            hostStatus: nextEnabled ? "idle" : "disabled",
            hostStatusDetail: undefined,
            hostStatuses: {},
            devices: nextEnabled ? state.devices : [],
            sessions: nextEnabled ? state.sessions : [],
            bootingDevices: nextEnabled ? state.bootingDevices : [],
            agentAccessEnabled: nextAgentAccess,
            onboardingCompleted: input.onboardingCompleted ?? state.onboardingCompleted,
          }));
        }),
      );
      if (nextEnabled && nextAgentAccess && input.agentAccessEnabled === true) {
        yield* agentReadinessIfSupported();
      }
      return yield* list;
    },
  );

  const findDevice = (
    state: DeviceServiceState,
    hostId: DeviceHostId,
    deviceId: DeviceId,
  ): DeviceSummary | undefined =>
    state.devices.find((device) => device.hostId === hostId && device.id === deviceId);

  const ensurePlatform = Effect.fn("DeviceService.ensurePlatform")(function* (
    host: DeviceHost.DeviceHost["Service"],
    platform: DevicePlatform,
  ) {
    const availability = yield* host.platformAvailability(platform);
    if (!availability.available) {
      return yield* new DevicePlatformUnavailableError({
        hostId: host.id,
        platform,
        reason: availability.reason ?? "Platform toolchain missing.",
      });
    }
  });

  const open: DeviceService["Service"]["open"] = Effect.fn("DeviceService.open")(
    function* (input, context) {
      const host = yield* resolveHost(input.hostId);
      yield* ensurePlatform(host, input.platform);
      const ready = yield* readiness(host.id);
      let state = yield* refresh(ready);
      let device = findDevice(state, host.id, input.deviceId);
      if (!device) {
        return yield* new DeviceNotFoundError({ hostId: host.id, deviceId: input.deviceId });
      }
      if (device.platform === "android" && !device.physical) {
        // Resolve the override on the device host the way its hub does.
        const encoders = yield* ready.run(ready.nodePath, [
          "-e",
          `const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg", ["-hide_banner", "-encoders"], {
    stdio: "inherit", timeout: 10000, killSignal: "SIGKILL",
  });
  process.exitCode = result.error ? 1 : (result.status ?? 1);`,
        ]);
        if (encoders.code !== 0) {
          return yield* new DevicePlatformUnavailableError({
            hostId: host.id,
            platform: "android",
            reason:
              "Android emulator video needs working ffmpeg with the libx264 encoder. Install it on the device host's PATH or set SERVE_EMU_FFMPEG there, then retry opening the emulator. After changing PATH or SERVE_EMU_FFMPEG, turn device support off and on for SSH hosts, or restart the local environment server.",
          });
        }
        if (!/^\s*V\S*[ \t]+libx264(?:[ \t]|$)/m.test(`${encoders.stdout}\n${encoders.stderr}`)) {
          return yield* new DevicePlatformUnavailableError({
            hostId: host.id,
            platform: "android",
            reason:
              "Android emulator video needs the libx264 encoder. Install an ffmpeg build that includes libx264 on the device host, then retry opening the emulator. After changing PATH or SERVE_EMU_FFMPEG, turn device support off and on for SSH hosts, or restart the local environment server.",
          });
        }
      }
      if (!device.booted && input.boot !== false) {
        const booting = { ...device, threadId: input.threadId };
        yield* publish((current) => ({
          ...current,
          bootingDevices: [
            ...(current.bootingDevices ?? []).filter(
              (entry) => entry.hostId !== booting.hostId || entry.id !== booting.id,
            ),
            booting,
          ],
        }));
        const bootedId = yield* ready.devices.boot(device, context).pipe(
          Effect.ensuring(
            publish((current) => ({
              ...current,
              bootingDevices: (current.bootingDevices ?? []).filter(
                (entry) => entry.hostId !== booting.hostId || entry.id !== booting.id,
              ),
            })),
          ),
        );
        state = yield* refresh(ready);
        device = findDevice(state, host.id, bootedId) ?? findDevice(state, host.id, device.id);
        if (!device) {
          return yield* new DeviceNotFoundError({ hostId: host.id, deviceId: bootedId });
        }
      } else if (device.booted) {
        yield* ready.devices.attach(device);
      }
      if (hosts.get(host.id) !== host)
        return yield* new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: "Host configuration changed. Retry the operation.",
        });
      const openedAt = DateTime.formatIso(yield* DateTime.now);
      const session: DeviceSession = {
        threadId: input.threadId,
        hostId: host.id,
        deviceId: device.id,
        platform: device.platform,
        openedAt,
      };
      yield* lifecycleLock.withPermit(
        Effect.gen(function* () {
          if (!(yield* readDeviceSettings).enabled)
            return yield* new DeviceHostUnavailableError({
              hostId: host.id,
              hostLabel: host.label,
              reason: "Device support was turned off while the device was opening.",
            });
          yield* publish((current) => ({
            ...current,
            sessions: [
              ...current.sessions.filter(
                (existing) =>
                  !(
                    existing.threadId === session.threadId &&
                    existing.hostId === session.hostId &&
                    existing.deviceId === session.deviceId
                  ),
              ),
              session,
            ],
          }));
        }),
      );
      return session;
    },
  );

  const shutdownDevice = Effect.fn("DeviceService.shutdownDevice")(function* (
    hostId: DeviceHostId,
    deviceId: DeviceId,
    platform: DevicePlatform,
  ) {
    const ready = yield* readiness(hostId);
    yield* ready.devices.shutdown({ id: deviceId, platform });
    yield* publish((state) => ({
      ...state,
      devices: state.devices.map((device) =>
        device.hostId === ready.hostId && device.id === deviceId
          ? { ...device, booted: false }
          : device,
      ),
      sessions: state.sessions.filter(
        (session) => !(session.hostId === ready.hostId && session.deviceId === deviceId),
      ),
    }));
    // Discovery can stall while an emulator saves its snapshot. A failed
    // refresh must not turn an accepted shutdown into an action failure.
    yield* refresh(ready).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Device discovery unavailable after shutdown", { cause }),
      ),
    );
  });

  const close: DeviceService["Service"]["close"] = Effect.fn("DeviceService.close")(
    function* (input) {
      const { state } = yield* SynchronizedRef.get(stateRef);
      const closing = state.sessions.filter(
        (session) =>
          session.threadId === input.threadId &&
          (input.hostId === undefined || session.hostId === input.hostId) &&
          (input.deviceId === undefined || session.deviceId === input.deviceId),
      );
      if (closing.length === 0) return;
      yield* publish((current) => ({
        ...current,
        sessions: current.sessions.filter((session) => !closing.includes(session)),
      }));
      if (input.shutdown) {
        yield* Effect.forEach(
          closing,
          (session) => shutdownDevice(session.hostId, session.deviceId, session.platform),
          { discard: true },
        );
      }
    },
  );

  const shutdown: DeviceService["Service"]["shutdown"] = Effect.fn("DeviceService.shutdown")(
    function* (input) {
      const host = yield* resolveHost(input.hostId);
      yield* shutdownDevice(host.id, input.deviceId, input.platform);
      yield* publish((current) => ({
        ...current,
        sessions: current.sessions.filter(
          (session) => !(session.hostId === host.id && session.deviceId === input.deviceId),
        ),
      }));
    },
  );

  const screenshot: DeviceService["Service"]["screenshot"] = Effect.fn("DeviceService.screenshot")(
    function* (input) {
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId);
      return { device, png: yield* ready.devices.screenshot(device) };
    },
  );

  const resolveDevice = Effect.fn("DeviceService.resolveDevice")(function* (
    hostId: DeviceHostId | undefined,
    deviceId: DeviceId,
  ) {
    const host = yield* resolveHost(hostId);
    const ready = yield* readiness(host.id);
    const { state } = yield* SynchronizedRef.get(stateRef);
    const device =
      findDevice(state, host.id, deviceId) ?? findDevice(yield* refresh(ready), host.id, deviceId);
    if (!device) return yield* new DeviceNotFoundError({ hostId: host.id, deviceId });
    return { ready, device };
  });

  const detail: DeviceService["Service"]["detail"] = Effect.fn("DeviceService.detail")(
    function* (input) {
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId);
      const read = yield* readDeviceDetail(ready, device.platform, device.id);
      return {
        hostId: ready.hostId,
        deviceId: device.id,
        settings: read.settings,
        foregroundApp: read.foregroundApp,
        readAt: DateTime.formatIso(yield* DateTime.now),
      };
    },
  );

  const action: DeviceService["Service"]["action"] = Effect.fn("DeviceService.action")(
    function* (input) {
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId);
      yield* runDeviceAction(ready, device.platform, input);
      return yield* detail({ hostId: ready.hostId, deviceId: device.id });
    },
  );

  const sessionsForThread: DeviceService["Service"]["sessionsForThread"] = (threadId) =>
    SynchronizedRef.get(stateRef).pipe(
      Effect.map(({ state }) => state.sessions.filter((session) => session.threadId === threadId)),
    );

  return {
    ...DeviceService.of({
      testHost,
      updateTool: (tool) =>
        lifecycleLock.withPermit(
          Effect.gen(function* () {
            if (!installTool)
              return yield* new DeviceOperationError({
                operation: "update device tool",
                reason: "request_failed",
                cause: new Error("Tool installation is unavailable in this device service."),
              });
            yield* installTool(tool);
            return yield* inspect;
          }),
        ),
      retryHost,
      inspect,
      easAccount: () =>
        Effect.fail(
          new DeviceEasAccountError({
            reason: "EAS accounts are unavailable in this device service.",
          }),
        ),
      agentCli: Effect.fail(
        new DeviceHostUnavailableError({
          hostId: LOCAL_DEVICE_HOST_ID,
          reason: "Agent CLI installation is unavailable in this device service.",
        }),
      ),
      agentTarget: Effect.fn("DeviceService.agentTarget")(function* (input) {
        const host = yield* resolveHost(input.hostId);
        const ready = yield* agentReadinessIfSupported(input.hostId);
        if (!ready)
          return yield* new DeviceHostUnavailableError({
            hostId: host.id,
            hostLabel: host.label,
            reason:
              "Agent device access requires enabled device support, agent access, and an available simulator platform on this host.",
          });
        const { configPath, agentDeviceId } = yield* lifecycleLock.withPermit(
          Effect.gen(function* () {
            if (hosts.get(host.id) !== host)
              return yield* new DeviceHostUnavailableError({
                hostId: host.id,
                hostLabel: host.label,
                reason: "Host configuration changed. Retry the operation.",
              });
            if (ready.devices.agentEndpoint) {
              const endpoint = yield* ready.devices.agentEndpoint(input.deviceId);
              return {
                configPath: yield* configureAgent(input.hostId, endpoint, input.deviceId),
                agentDeviceId: endpoint.agentDeviceId,
              };
            }
            if (!ready.agentDevice)
              return yield* new DeviceHostUnavailableError({
                hostId: host.id,
                hostLabel: host.label,
                reason: "This host has no agent-device daemon.",
              });
            return {
              configPath: yield* configureAgent(input.hostId, ready.agentDevice),
              agentDeviceId: input.deviceId,
            };
          }),
        );
        const session = yield* agentDeviceSession(
          input.threadId,
          input.hostId,
          input.deviceId,
        ).pipe(Effect.provideService(Crypto.Crypto, crypto));
        return { agentDeviceId, args: ["--config", configPath, "--session", session] };
      }),
      state: SynchronizedRef.get(stateRef).pipe(Effect.map(({ state }) => state)),
      subscribe: PubSub.subscribe(statePubSub),
      configure,
      list,
      open,
      close,
      shutdown,
      detail,
      action,
      screenshot,
      readiness,
      readinessIfSupported,
      agentReadinessIfSupported,
      currentReadiness,
      sessionsForThread,
    }),
    setHostStatus,
    withLifecycleLock: lifecycleLock.withPermit,
    refreshHosts: Effect.gen(function* () {
      const summaries = yield* Effect.forEach(hosts.values(), (host) => host.summary);
      const unchanged = (id: DeviceHostId) =>
        hosts.has(id) && hosts.get(id) === publishedHosts.get(id);
      yield* publish((state) => ({
        ...state,
        hosts: summaries,
        hostStatuses: Object.fromEntries(
          Object.entries(state.hostStatuses).filter(([id]) => unchanged(id)),
        ),
        devices: state.devices.filter((device) => unchanged(device.hostId)),
        sessions: state.sessions.filter((session) => unchanged(session.hostId)),
      }));
      publishedHosts = new Map(hosts);
    }),
  };
});

/** @public */
/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const localHost = yield* DeviceHost.DeviceHost;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const scope = yield* Scope.Scope;
  const hosts = new Map<DeviceHostId, DeviceHost.DeviceHost["Service"]>([
    [localHost.id, localHost],
  ]);
  const crypto = yield* Crypto.Crypto;
  const configPath = (hostId: DeviceHostId, deviceId?: DeviceId) =>
    agentDeviceConfigPath(config.stateDir, hostId, path, deviceId).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
    );
  const configureAgent = Effect.fn("DeviceService.configureAgent")(
    function* (
      hostId: DeviceHostId,
      endpoint: DeviceHost.AgentDaemonEndpoint,
      deviceId?: DeviceId,
    ) {
      const file = yield* configPath(hostId, deviceId);
      yield* writeAgentDeviceConfig(file, endpoint);
      return file;
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.mapError(
      (cause) =>
        new DeviceOperationError({
          operation: "configure agent",
          reason: "settings_failed",
          cause,
        }),
    ),
  );
  const probeContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof SshDeviceHost.probe>>>();
  const localTargetContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof isLocalSshDeviceHost>>>();
  const service = yield* makeWithHosts(
    hosts,
    (host) =>
      Effect.gen(function* () {
        if (yield* isLocalSshDeviceHost(host).pipe(Effect.provide(localTargetContext))) {
          return yield* localHost.summary;
        }
        return yield* SshDeviceHost.probe(host).pipe(Effect.provide(probeContext));
      }).pipe(
        Effect.mapError(
          (error) =>
            new DeviceOperationError({
              operation: "probe host",
              reason: "request_failed",
              cause: error,
            }),
        ),
      ),
    configureAgent,
    (tool) =>
      (tool === "hub" ? ensureDeviceHub(config.baseDir) : ensureAgentDevice(config.baseDir)).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({
              operation: "update device tool",
              reason: "command_failed",
              // Only the exit code goes into the shown message; npm's stderr can carry registry credentials.
              ...(cause.exitCode !== undefined ? { exitCode: cause.exitCode } : {}),
              cause,
            }),
        ),
      ),
  );
  const hostContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof SshDeviceHost.make>>>();
  const easContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof EasDeviceHost.make>>>();
  const configured = new Map<string, { config: DeviceHostConfig; scope: Scope.Closeable }>();
  const unchanged = (current: DeviceHostConfig, previous: DeviceHostConfig) =>
    current.kind === "ssh" && previous.kind === "ssh"
      ? current.label === previous.label &&
        current.target === previous.target &&
        current.port === previous.port &&
        current.identityFile === previous.identityFile
      : JSON.stringify(current) === JSON.stringify(previous);
  const reconcile = Effect.fn("DeviceService.reconcile")(function* (
    configuredHosts: ReadonlyArray<DeviceHostConfig>,
  ) {
    const next = yield* remoteSshDeviceHosts(configuredHosts).pipe(
      Effect.provide(localTargetContext),
    );
    const removed = yield* service.withLifecycleLock(
      Effect.gen(function* () {
        const removed: Array<{ id: string; scope: Scope.Closeable }> = [];
        for (const [id, previous] of configured) {
          if (next.some((host) => host.id === id && unchanged(host, previous.config))) continue;
          hosts.delete(id);
          configured.delete(id);
          removed.push({ id, scope: previous.scope });
        }
        if (removed.length > 0) yield* service.refreshHosts;
        return removed;
      }),
    );
    // Stop old writers before deleting config files or publishing replacements, without blocking healthy hosts.
    yield* Effect.forEach(
      removed,
      ({ id, scope }) =>
        Effect.gen(function* () {
          yield* Scope.close(scope, Exit.void);
          yield* fs.remove(yield* configPath(id), { force: true }).pipe(Effect.ignore);
        }),
      { concurrency: 4, discard: true },
    );
    yield* service.withLifecycleLock(
      Effect.gen(function* () {
        let added = false;
        for (const host of next) {
          if (configured.has(host.id)) continue;
          added = true;
          const hostScope = yield* Scope.fork(scope);
          if (host.kind === "eas") {
            // Closing this scope stops the host's running sessions, so a changed
            // limit or token never leaves a billed session behind.
            const instance = yield* EasDeviceHost.make(host).pipe(
              Effect.provideService(Scope.Scope, hostScope),
              Effect.provide(easContext),
            );
            hosts.set(host.id, instance);
            configured.set(host.id, { config: host, scope: hostScope });
            continue;
          }
          const instance = yield* SshDeviceHost.make(
            host,
            (ready) =>
              (ready.agentDevice
                ? configureAgent(host.id, ready.agentDevice).pipe(Effect.asVoid)
                : Effect.void
              ).pipe(
                Effect.mapError(
                  (error) =>
                    new DeviceHost.DeviceHostError({
                      hostId: host.id,
                      step: "configuring agent access",
                      cause: error,
                    }),
                ),
              ),
            (status, detail) =>
              service
                .setHostStatus(host.id, { status, ...(detail ? { detail } : {}) })
                .pipe(Effect.asVoid),
          ).pipe(Effect.provideService(Scope.Scope, hostScope), Effect.provide(hostContext));
          hosts.set(host.id, instance);
          configured.set(host.id, { config: host, scope: hostScope });
        }
        // Refresh again after removed scopes closed so a late status write from an old host cannot linger.
        if (added || removed.length > 0) yield* service.refreshHosts;
      }),
    );
  });
  const changes = yield* settings.subscribeChanges;
  // Settings keep EAS hosts apart from SSH hosts; an id both lists use stays the SSH host's.
  const configuredHosts = (value: {
    readonly deviceHosts: ReadonlyArray<SshDeviceHostConfig>;
    readonly easDeviceHosts: ReadonlyArray<EasDeviceHostConfig>;
  }): ReadonlyArray<DeviceHostConfig> => [
    ...value.deviceHosts,
    ...value.easDeviceHosts.filter((host) => !value.deviceHosts.some((ssh) => ssh.id === host.id)),
  ];
  yield* reconcile(configuredHosts(yield* settings.getSettings));
  yield* changes.pipe(
    Stream.runForEach((value) => reconcile(configuredHosts(value))),
    Effect.forkIn(scope),
  );
  yield* Effect.addFinalizer(() =>
    Effect.forEach(configured.values(), (value) => Scope.close(value.scope, Exit.void), {
      discard: true,
      concurrency: 4,
    }),
  );
  const easAccount: DeviceService["Service"]["easAccount"] = Effect.fn("DeviceService.easAccount")(
    function* (input) {
      const saved =
        input.hostId === undefined
          ? ""
          : ((yield* settings.getSettings).easDeviceHosts.find((host) => host.id === input.hostId)
              ?.accessToken ?? "");
      const credential = yield* resolveExpoCredential(input.accessToken ?? saved);
      const viewer = yield* makeExpoApi(yield* HttpClient.HttpClient, credential).viewer;
      return { signedInAs: viewer.name, credentialSource: credential.source, apps: viewer.apps };
    },
    Effect.provide(easContext),
    // Only bounded text reaches the browser: the credential errors' own
    // guidance, or a category for what Expo answered, never Expo's text.
    Effect.mapError(
      (cause) =>
        new DeviceEasAccountError({
          reason:
            cause._tag === "ExpoApiError"
              ? cause.status === 401 || cause.status === 403
                ? `Expo rejected the credential (HTTP ${cause.status}).`
                : cause.rejected
                  ? "Expo refused the account check."
                  : "Could not complete the Expo account check."
              : cause.message,
        }),
    ),
  );

  return {
    ...service,
    easAccount,
    agentCli: resolveNodeExecutable("Device automation").pipe(
      Effect.andThen(ensureAgentDevice(config.baseDir)),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.map((tool) => tool.entryPath),
      Effect.mapError((error) =>
        error._tag === "NodeRuntimeUnavailableError"
          ? new DeviceHostUnavailableError({
              hostId: LOCAL_DEVICE_HOST_ID,
              hostLabel: LOCAL_DEVICE_HOST_LABEL,
              reason: nodeRuntimeUnavailableMessage("Device automation"),
              cause: error,
            })
          : new DeviceOperationError({
              operation: "install agent CLI",
              reason: "command_failed",
              cause: error,
            }),
      ),
    ),
  };
});

export const layer = Layer.effect(DeviceService, make).pipe(Layer.provide(LocalDeviceHost.layer));

export const stateStream = (service: DeviceService["Service"]): Stream.Stream<DeviceServiceState> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before reading the snapshot so no change between the two
      // is lost; the scope lives as long as the stream does.
      const subscription = yield* service.subscribe;
      const initial = yield* service.state;
      return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
    }),
  ).pipe(Stream.scoped);

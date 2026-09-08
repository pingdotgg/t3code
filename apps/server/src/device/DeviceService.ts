/**
 * Device discovery, per-thread device sessions, and the state stream clients
 * render the Device panel from.
 *
 * Discovery and boot go through expo-device-hub's JSON API rather than
 * shelling out to simctl and adb here: the hub already normalizes both
 * platforms into one device shape and is the process that has to know a
 * device is booted before it can stream it. Sessions are the server's own
 * bookkeeping — which thread is looking at which device — so the panel and
 * the `device_*` tools agree, and so a `device_open` from an agent surfaces in
 * every connected client the way `preview_open` does.
 */
import {
  type DeviceActionInput,
  type DeviceCloseInput,
  type DeviceConfigureInput,
  type DeviceDetail,
  type DeviceDetailInput,
  type DeviceError,
  type DeviceHostId,
  type DeviceId,
  DeviceBootError,
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
  LOCAL_DEVICE_HOST_ID,
  type ThreadId,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ensureAgentDeviceCli } from "./DeviceToolchain.ts";
import { ServerConfig } from "../config.ts";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";

import { readDeviceDetail, runDeviceAction } from "./DeviceActions.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as LocalDeviceHost from "./LocalDeviceHost.ts";

/** Origin-relative prefix the hub is proxied under. See DeviceHubProxy. */
export const DEVICE_HUB_ROUTE_PREFIX = "/api/device-hub";

const BOOT_TIMEOUT = Duration.minutes(3);
const SCREENSHOT_TIMEOUT = Duration.seconds(20);

const HubDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  booted: Schema.Boolean,
  physical: Schema.Boolean,
});
const HubDeviceList = Schema.Struct({
  simulators: Schema.Array(HubDevice),
  emulators: Schema.Array(HubDevice),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});
const HubActionResult = Schema.Struct({
  ok: Schema.Boolean,
  id: Schema.optional(Schema.String),
  serial: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

export interface DeviceScreenshot {
  readonly device: DeviceSummary;
  readonly png: Uint8Array;
}

export interface DeviceReadiness extends DeviceHost.DeviceHostReady {
  readonly hostId: DeviceHostId;
}

export interface DeviceAgentReadiness extends DeviceReadiness {
  readonly agentDevice: DeviceHost.AgentDeviceEndpoint;
}

export class DeviceService extends Context.Service<
  DeviceService,
  {
    readonly agentCli: Effect.Effect<string, DeviceError>;
    readonly agentTarget: (input: {
      threadId: ThreadId;
      hostId: DeviceHostId;
      deviceId: DeviceId;
    }) => Effect.Effect<ReadonlyArray<string>, DeviceError>;
    readonly state: Effect.Effect<DeviceServiceState>;
    readonly subscribe: Effect.Effect<PubSub.Subscription<DeviceServiceState>, never, Scope.Scope>;
    readonly configure: (
      input: DeviceConfigureInput,
    ) => Effect.Effect<DeviceServiceState, DeviceError>;
    /** Refreshes devices only after device support has been enabled. */
    readonly list: Effect.Effect<DeviceServiceState, DeviceError>;
    readonly open: (input: DeviceOpenInput) => Effect.Effect<DeviceSession, DeviceError>;
    readonly close: (input: DeviceCloseInput) => Effect.Effect<void, DeviceError>;
    readonly shutdown: (input: DeviceShutdownInput) => Effect.Effect<void, DeviceError>;
    /** Current settings and foreground app for one device. */
    readonly detail: (input: DeviceDetailInput) => Effect.Effect<DeviceDetail, DeviceError>;
    /** Runs one action, then returns the refreshed detail. */
    readonly action: (input: DeviceActionInput) => Effect.Effect<DeviceDetail, DeviceError>;
    readonly screenshot: (input: {
      readonly hostId?: DeviceHostId | undefined;
      readonly deviceId: DeviceId;
    }) => Effect.Effect<DeviceScreenshot, DeviceError>;
    /** Host endpoints for the proxy and the provider environment. */
    readonly readiness: (hostId?: DeviceHostId) => Effect.Effect<DeviceReadiness, DeviceError>;
    /**
     * `readiness` only when the host can run at least one platform; a machine
     * with no simulator toolchain never installs or starts anything.
     */
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

const vendorPrefix = (platform: DevicePlatform) =>
  platform === "ios" ? "/vendor/serve-sim" : "/vendor/serve-emu";

export const makeWithHosts = Effect.fn("DeviceService.makeWithHosts")(function* (hosts: ReadonlyMap<DeviceHostId, DeviceHost.DeviceHost["Service"]>, configureAgent: (hostId: DeviceHostId, ready: DeviceHost.DeviceAgentReady) => Effect.Effect<string, DeviceError> = () => Effect.succeed("")) {
  const settings = yield* ServerSettings.ServerSettingsService;
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

  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const statePubSub = yield* PubSub.unbounded<DeviceServiceState>();
  const initialHosts = yield* Effect.forEach(hosts.values(), (host) => host.summary);
  const stateRef = yield* SynchronizedRef.make<ServiceState>({
    state: {
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

  const resolveHost = (hostId: DeviceHostId | undefined) =>
    Effect.gen(function* () {
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
    publish((state) => ({
      ...state,
      ...(hostId === LOCAL_DEVICE_HOST_ID
        ? { hostStatus: status.status, hostStatusDetail: status.detail }
        : {}),
      hostStatuses: { ...state.hostStatuses, [hostId]: status },
    }));

  const readiness: DeviceService["Service"]["readiness"] = Effect.fn("DeviceService.readiness")(
    function* (hostId) {
      const host = yield* resolveHost(hostId);
      if (!(yield* readDeviceSettings).enabled) {
        return yield* new DeviceHostUnavailableError({
          hostId: host.id,
          reason:
            "Device support is off. Enable it in the Device panel before installing or starting device tools.",
        });
      }
      const ready = yield* host
        .ensureReady((status) => setHostStatus(host.id, { status }).pipe(Effect.asVoid))
        .pipe(
          Effect.tapError((error) =>
            setHostStatus(host.id, { status: "failed", detail: error.message }),
          ),
          Effect.mapError(
            (error) => new DeviceHostUnavailableError({ hostId: host.id, reason: error.message }),
          ),
        );
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
    if (!summary.platforms.some((platform) => platform.available)) return null;
    return yield* readiness(host.id);
  });

  const agentReadinessIfSupported: DeviceService["Service"]["agentReadinessIfSupported"] =
    Effect.fn("DeviceService.agentReadinessIfSupported")(function* (hostId) {
      const deviceSettings = yield* readDeviceSettings;
      if (!deviceSettings.enabled || !deviceSettings.agentAccessEnabled) return null;
      const host = yield* resolveHost(hostId);
      const summary = yield* host.summary;
      if (!summary.platforms.some((platform) => platform.available)) return null;
      const ready = yield* host
        .ensureAgentReady((phase) => setHostStatus(host.id, { status: phase }).pipe(Effect.asVoid))
        .pipe(
          Effect.tapError((error) =>
            setHostStatus(host.id, { status: "failed", detail: error.message }),
          ),
          Effect.mapError(
            (error) => new DeviceHostUnavailableError({ hostId: host.id, reason: error.message }),
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

  const hubJson = <A, I>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I>,
    operation: string,
    timeout: Duration.Input = Duration.seconds(15),
  ) =>
    httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.mapError(
        (cause) =>
          new DeviceOperationError({
            operation,
            reason: "request_failed",
            cause,
          }),
      ),
    );

  const fetchDevices = Effect.fn("DeviceService.fetchDevices")(function* (ready: DeviceReadiness) {
    const list = yield* hubJson(
      HttpClientRequest.get(`${ready.hub.origin}/api/devices`),
      HubDeviceList,
      "list",
    );
    const toSummary = (device: typeof HubDevice.Type): DeviceSummary => ({
      hostId: ready.hostId,
      id: device.id,
      platform: device.platform,
      name: device.name,
      version: device.version,
      booted: device.booted,
      physical: device.physical,
    });
    const devices = [...list.simulators, ...list.emulators].map(toSummary);
    const host = yield* resolveHost(ready.hostId);
    if ((yield* host.platformAvailability("android")).available) {
      const avds = yield* ready.run("emulator", ["-list-avds"]);
      if (avds.code !== 0) {
        return yield* new DeviceOperationError({
          operation: "list",
          reason: "command_failed",
          exitCode: avds.code,
          cause: avds,
        });
      }
      for (const name of avds.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)) {
        if (!devices.some((device) => device.platform === "android" && device.name === name)) {
          devices.push({
            hostId: ready.hostId,
            id: name,
            name,
            platform: "android",
            version: "Android",
            booted: false,
            physical: false,
          });
        }
      }
    }
    return { devices, detail: list.errors?.map((error) => error.message).join("\n") || undefined };
  });

  const refresh = Effect.fn("DeviceService.refresh")(function* (ready: DeviceReadiness) {
    const { devices, detail } = yield* fetchDevices(ready);
    const hostSummaries = yield* Effect.forEach(hosts.values(), (host) => host.summary);
    return yield* lifecycleLock.withPermit(
      Effect.gen(function* () {
        if (!(yield* readDeviceSettings).enabled)
          return (yield* SynchronizedRef.get(stateRef)).state;
        return yield* publish((state) => ({
          ...state,
          hosts: hostSummaries,
          ...(ready.hostId === LOCAL_DEVICE_HOST_ID ? { hostStatusDetail: detail } : {}),
          devices: [
            ...state.devices.filter((device) => device.hostId !== ready.hostId),
            ...devices,
          ],
          hostStatuses: {
            ...state.hostStatuses,
            [ready.hostId]: { status: "ready", ...(detail ? { detail } : {}) },
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
            setHostStatus(host.id, { status: "failed", detail: error.message }),
          ),
        ),
      { concurrency: 4 },
    );
    return (yield* SynchronizedRef.get(stateRef)).state;
  }).pipe(Effect.withSpan("DeviceService.list"));

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

  /**
   * Boot through the hub so its device list and the streaming helper both see
   * the device come up. Android AVDs change id when they boot (AVD name to
   * emulator serial), so the returned id is authoritative.
   */
  const boot = Effect.fn("DeviceService.boot")(function* (
    ready: DeviceReadiness,
    device: DeviceSummary,
  ) {
    const result = yield* HttpClientRequest.post(`${ready.hub.origin}/api/devices/boot`).pipe(
      HttpClientRequest.bodyJson({ platform: device.platform, id: device.id, name: device.name }),
      Effect.mapError(
        (cause) =>
          new DeviceOperationError({ operation: "boot", reason: "invalid_payload", cause }),
      ),
      Effect.flatMap((request) => hubJson(request, HubActionResult, "boot", BOOT_TIMEOUT)),
    );
    if (!result.ok) {
      return yield* new DeviceBootError({
        hostId: ready.hostId,
        deviceId: device.id,
        reason: /insufficient.*(?:disk|space)|not enough.*(?:disk|space)|no space left/i.test(
          result.error ?? "",
        )
          ? "disk_space"
          : /timed? out|timeout/i.test(result.error ?? "")
            ? "timeout"
            : "launch_failed",
        cause: result,
      });
    }
    if (device.platform === "ios") {
      // Booting alone does not attach a serve-sim helper; the grid start
      // does both and is idempotent for a booted simulator.
      yield* HttpClientRequest.post(
        `${ready.hub.origin}${vendorPrefix("ios")}/grid/api/start`,
      ).pipe(
        HttpClientRequest.bodyJson({ udid: device.id }),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({ operation: "boot", reason: "invalid_payload", cause }),
        ),
        Effect.flatMap((request) =>
          hubJson(request, HubActionResult, "attach stream", BOOT_TIMEOUT),
        ),
      );
    }
    return result.serial ?? result.id ?? device.id;
  });

  const open: DeviceService["Service"]["open"] = Effect.fn("DeviceService.open")(function* (input) {
    const host = yield* resolveHost(input.hostId);
    yield* ensurePlatform(host, input.platform);
    const ready = yield* readiness(host.id);
    let state = yield* refresh(ready);
    let device = findDevice(state, host.id, input.deviceId);
    if (!device) {
      return yield* new DeviceNotFoundError({ hostId: host.id, deviceId: input.deviceId });
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
      const bootedId = yield* boot(ready, device).pipe(
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
    } else if (device.platform === "ios" && device.booted) {
      // A simulator booted outside T3 has no helper attached yet.
      yield* HttpClientRequest.post(
        `${ready.hub.origin}${vendorPrefix("ios")}/grid/api/start`,
      ).pipe(
        HttpClientRequest.bodyJson({ udid: device.id }),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({ operation: "open", reason: "invalid_payload", cause }),
        ),
        Effect.flatMap((request) =>
          hubJson(request, HubActionResult, "attach stream", BOOT_TIMEOUT),
        ),
      );
    }
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
  });

  const shutdownDevice = Effect.fn("DeviceService.shutdownDevice")(function* (
    hostId: DeviceHostId,
    deviceId: DeviceId,
    platform: DevicePlatform,
  ) {
    const ready = yield* readiness(hostId);
    yield* HttpClientRequest.post(`${ready.hub.origin}/api/devices/shutdown`).pipe(
      HttpClientRequest.bodyJson({ platform, id: deviceId }),
      Effect.mapError(
        (cause) =>
          new DeviceOperationError({ operation: "shutdown", reason: "invalid_payload", cause }),
      ),
      Effect.flatMap((request) => hubJson(request, HubActionResult, "shutdown")),
      Effect.flatMap((result) =>
        result.ok
          ? Effect.void
          : Effect.fail(
              new DeviceOperationError({
                operation: "shutdown",
                reason: "hub_rejected",
                cause: result,
              }),
            ),
      ),
    );
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
      // Sessions on a powered-off device are stale in every thread.
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
      const url = `${ready.hub.origin}${vendorPrefix(device.platform)}/api/screenshot?device=${encodeURIComponent(device.id)}`;
      const png = yield* httpClient.execute(HttpClientRequest.post(url)).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.scoped,
        Effect.timeout(SCREENSHOT_TIMEOUT),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({
              operation: "screenshot",
              reason: "request_failed",
              cause,
            }),
        ),
      );
      return { device, png };
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

  return DeviceService.of({
    agentCli: Effect.fail(
      new DeviceOperationError({
        operation: "install agent CLI",
        detail: "CLI installation unavailable.",
      }),
    ),
    agentTarget: (input) =>
      Effect.gen(function* () {
        const ready = yield* agentReadinessIfSupported(input.hostId);
        if (!ready) return yield* new DeviceHostUnavailableError({hostId: input.hostId, reason: "Agent device access is disabled."});
        const configPath = yield* configureAgent(input.hostId, ready);
        return [
          "--config",
          configPath,
          "--session",
          agentDeviceSession(input.threadId, input.hostId, input.deviceId),
        ];
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
  });
});

export const make = Effect.gen(function* () {
  const localHost = yield* DeviceHost.DeviceHost;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof ensureAgentDeviceCli>>>();
  const service = yield* makeWithHosts(new Map([[localHost.id, localHost]]), (hostId, ready) => {
    const file = agentDeviceConfigPath(config.stateDir, hostId, path);
    return writeAgentDeviceConfig(file, ready.agentDevice).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new DeviceOperationError({ operation: "configure agent", reason: "settings_failed", cause }),
      ),
      Effect.as(file),
    );
  });
  return {
    ...service,
    agentCli: ensureAgentDeviceCli(config.baseDir).pipe(
      Effect.provide(cliContext),
      Effect.map((tool) => tool.entryPath),
      Effect.mapError(
        (error) =>
          new DeviceOperationError({ operation: "install agent CLI", detail: error.message }),
      ),
    ),
  };
});

export const layer = Layer.effect(DeviceService, make).pipe(Layer.provide(LocalDeviceHost.layer));

/** State stream for WS subscribers: current snapshot first, then every change. */
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

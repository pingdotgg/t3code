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
  type DeviceCloseInput,
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
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type { DeviceHost, DeviceHostReady } from "./DeviceHost.ts";
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

export interface DeviceReadiness extends DeviceHostReady {
  readonly hostId: DeviceHostId;
}

export class DeviceService extends Context.Service<
  DeviceService,
  {
    readonly state: Effect.Effect<DeviceServiceState>;
    readonly subscribe: Effect.Effect<PubSub.Subscription<DeviceServiceState>, never, Scope.Scope>;
    /** Refreshes device discovery; starts the host helpers on first call. */
    readonly list: Effect.Effect<DeviceServiceState, DeviceError>;
    readonly open: (input: DeviceOpenInput) => Effect.Effect<DeviceSession, DeviceError>;
    readonly close: (input: DeviceCloseInput) => Effect.Effect<void, DeviceError>;
    readonly shutdown: (input: DeviceShutdownInput) => Effect.Effect<void, DeviceError>;
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
    readonly currentReadiness: (hostId?: DeviceHostId) => Effect.Effect<DeviceReadiness | null>;
    readonly sessionsForThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<DeviceSession>>;
  }
>()("t3/device/DeviceService") {}

interface ServiceState {
  readonly state: DeviceServiceState;
}

const vendorPrefix = (platform: DevicePlatform) =>
  platform === "ios" ? "/vendor/serve-sim" : "/vendor/serve-emu";

export const make = Effect.gen(function* () {
  const localHost = yield* LocalDeviceHost.make();
  const hosts: ReadonlyMap<DeviceHostId, DeviceHost> = new Map([[localHost.id, localHost]]);
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const statePubSub = yield* PubSub.unbounded<DeviceServiceState>();
  const initialHosts = yield* Effect.forEach(hosts.values(), (host) => host.summary);
  const stateRef = yield* SynchronizedRef.make<ServiceState>({
    state: {
      hosts: initialHosts,
      hostStatus: "idle",
      devices: [],
      sessions: [],
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

  const readiness: DeviceService["Service"]["readiness"] = Effect.fn("DeviceService.readiness")(
    function* (hostId) {
      const host = yield* resolveHost(hostId);
      const ready = yield* host
        .ensureReady((phase) =>
          publish((state) => ({ ...state, hostStatus: phase, hostStatusDetail: undefined })).pipe(
            Effect.asVoid,
          ),
        )
        .pipe(
          Effect.tapError((error) =>
            publish((state) => ({
              ...state,
              hostStatus: "failed",
              hostStatusDetail: error.message,
            })),
          ),
          Effect.mapError(
            (error) => new DeviceHostUnavailableError({ hostId: host.id, reason: error.message }),
          ),
        );
      yield* SynchronizedRef.get(stateRef).pipe(
        Effect.flatMap(({ state }) =>
          state.hostStatus === "ready"
            ? Effect.void
            : publish((current) => ({
                ...current,
                hostStatus: "ready",
                hostStatusDetail: undefined,
              })),
        ),
      );
      return { hostId: host.id, ...ready };
    },
  );

  const readinessIfSupported: DeviceService["Service"]["readinessIfSupported"] = Effect.fn(
    "DeviceService.readinessIfSupported",
  )(function* (hostId) {
    const host = yield* resolveHost(hostId);
    const summary = yield* host.summary;
    if (!summary.platforms.some((platform) => platform.available)) return null;
    return yield* readiness(host.id);
  });

  const currentReadiness: DeviceService["Service"]["currentReadiness"] = (hostId) =>
    resolveHost(hostId).pipe(
      Effect.flatMap((host) =>
        host.current.pipe(Effect.map((ready) => (ready ? { hostId: host.id, ...ready } : null))),
      ),
      Effect.orElseSucceed(() => null),
    );

  const hubJson = <A, I>(
    ready: DeviceReadiness,
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
            detail: `${ready.hub.origin}: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      ),
    );

  const fetchDevices = Effect.fn("DeviceService.fetchDevices")(function* (ready: DeviceReadiness) {
    const list = yield* hubJson(
      ready,
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
    return [...list.simulators, ...list.emulators].map(toSummary);
  });

  const refresh = Effect.fn("DeviceService.refresh")(function* (ready: DeviceReadiness) {
    const devices = yield* fetchDevices(ready);
    const hostSummaries = yield* Effect.forEach(hosts.values(), (host) => host.summary);
    return yield* publish((state) => ({ ...state, hosts: hostSummaries, devices }));
  });

  const list: DeviceService["Service"]["list"] = Effect.gen(function* () {
    const ready = yield* readiness();
    return yield* refresh(ready);
  }).pipe(Effect.withSpan("DeviceService.list"));

  const findDevice = (
    state: DeviceServiceState,
    hostId: DeviceHostId,
    deviceId: DeviceId,
  ): DeviceSummary | undefined =>
    state.devices.find((device) => device.hostId === hostId && device.id === deviceId);

  const ensurePlatform = Effect.fn("DeviceService.ensurePlatform")(function* (
    host: DeviceHost,
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
        (cause) => new DeviceOperationError({ operation: "boot", detail: String(cause) }),
      ),
      Effect.flatMap((request) => hubJson(ready, request, HubActionResult, "boot", BOOT_TIMEOUT)),
    );
    if (!result.ok) {
      return yield* new DeviceBootError({
        hostId: ready.hostId,
        deviceId: device.id,
        detail: result.error ?? "The device hub reported a boot failure.",
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
          (cause) => new DeviceOperationError({ operation: "boot", detail: String(cause) }),
        ),
        Effect.flatMap((request) =>
          hubJson(ready, request, HubActionResult, "attach stream", BOOT_TIMEOUT),
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
      const bootedId = yield* boot(ready, device);
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
          (cause) => new DeviceOperationError({ operation: "open", detail: String(cause) }),
        ),
        Effect.flatMap((request) =>
          hubJson(ready, request, HubActionResult, "attach stream", BOOT_TIMEOUT),
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
        (cause) => new DeviceOperationError({ operation: "shutdown", detail: String(cause) }),
      ),
      Effect.flatMap((request) => hubJson(ready, request, HubActionResult, "shutdown")),
      Effect.flatMap((result) =>
        result.ok
          ? Effect.void
          : Effect.fail(
              new DeviceOperationError({
                operation: "shutdown",
                detail: result.error ?? "The device hub reported a shutdown failure.",
              }),
            ),
      ),
    );
    yield* refresh(ready);
  });

  const close: DeviceService["Service"]["close"] = Effect.fn("DeviceService.close")(
    function* (input) {
      const { state } = yield* SynchronizedRef.get(stateRef);
      const closing = state.sessions.filter(
        (session) =>
          session.threadId === input.threadId &&
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
      const host = yield* resolveHost(input.hostId);
      const ready = yield* readiness(host.id);
      const { state } = yield* SynchronizedRef.get(stateRef);
      const device = findDevice(state, host.id, input.deviceId);
      if (!device) {
        return yield* new DeviceNotFoundError({ hostId: host.id, deviceId: input.deviceId });
      }
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
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );
      return { device, png };
    },
  );

  const sessionsForThread: DeviceService["Service"]["sessionsForThread"] = (threadId) =>
    SynchronizedRef.get(stateRef).pipe(
      Effect.map(({ state }) => state.sessions.filter((session) => session.threadId === threadId)),
    );

  return DeviceService.of({
    state: SynchronizedRef.get(stateRef).pipe(Effect.map(({ state }) => state)),
    subscribe: PubSub.subscribe(statePubSub),
    list,
    open,
    close,
    shutdown,
    screenshot,
    readiness,
    readinessIfSupported,
    currentReadiness,
    sessionsForThread,
  });
}).pipe(Effect.withSpan("DeviceService.make"));

export const layer = Layer.effect(DeviceService, make);

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

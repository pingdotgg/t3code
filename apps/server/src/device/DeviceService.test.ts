import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DeviceId,
  LOCAL_DEVICE_HOST_ID,
  ThreadId,
  type DeviceServiceState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { NodeRuntimeUnavailableError } from "@t3tools/shared/nodeRuntime";

import { type DeviceService, makeWithHosts, stateStream } from "./DeviceService.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const baseState: DeviceServiceState = {
  hosts: [],
  hostStatus: "idle",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
};

describe("DeviceService.stateStream", () => {
  it.effect("emits the current snapshot and then every published change", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<DeviceServiceState>();
      const current = yield* Ref.make(baseState);
      const service: Pick<DeviceService["Service"], "state" | "subscribe"> = {
        state: Ref.get(current),
        subscribe: PubSub.subscribe(pubsub),
      };

      const collected = yield* stateStream(service as DeviceService["Service"]).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      for (const revision of [1, 2]) {
        const next = { ...baseState, revision, hostStatus: "ready" as const };
        yield* Ref.set(current, next);
        yield* PubSub.publish(pubsub, next);
      }
      const seen = yield* Fiber.join(collected);
      expect(seen.map((state) => state.revision)).toEqual([0, 1, 2]);
    }),
  );
});

const fixture = Effect.fn("fixture")(function* (
  onBoot: Effect.Effect<void> = Effect.void,
  bootError?: string,
  failListAfterShutdown = false,
  runtimeFailure?: NodeRuntimeUnavailableError | DeviceHost.DeviceHostError,
) {
  const settings = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
  const starts: string[] = [];
  const agentStarts: string[] = [];
  const agentStops: string[] = [];
  const requests: string[] = [];
  let booted = false;
  let shutDown = false;
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: () => Effect.succeed({ code: 0, stdout: "Pixel_API_35\n", stderr: "" }),
  };
  const host: DeviceHost.DeviceHost["Service"] = {
    id: LOCAL_DEVICE_HOST_ID,
    summary: Effect.succeed({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "Test server",
      platforms: [{ platform: "android", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: false,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: (onPhase) =>
      Effect.gen(function* () {
        if (runtimeFailure) return yield* runtimeFailure;
        starts.push("start");
        yield* onPhase("installing", "Updating device hub from 0.9.0 to 0.10.1…");
        return ready;
      }),
    ensureAgentReady: (onPhase) =>
      Effect.gen(function* () {
        if (runtimeFailure) return yield* runtimeFailure;
        agentStarts.push("start");
        yield* onPhase("starting");
        return {
          ...ready,
          agentDevice: { baseUrl: "http://agent.test", token: "test", entryPath: "/agent" },
        };
      }),
    current: Effect.succeed(null),
    stopAgent: Effect.sync(() => {
      agentStops.push("stop");
    }),
    stop: Effect.sync(() => {
      starts.push("stop");
    }),
  };
  const service = yield* makeWithHosts(new Map([[host.id, host]])).pipe(
    Effect.provideService(DeviceHost.DeviceHost, host),
    Effect.provideService(
      ServerSettingsService,
      ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settings),
        updateSettings: (patch) =>
          Ref.updateAndGet(settings, (current) => ({
            ...current,
            enableDeviceSupport: patch.enableDeviceSupport ?? current.enableDeviceSupport,
            enableAgentDeviceAccess:
              patch.enableAgentDeviceAccess ?? current.enableAgentDeviceAccess,
            deviceOnboardingCompleted:
              patch.deviceOnboardingCompleted ?? current.deviceOnboardingCompleted,
          })),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request.url);
          if (request.url.includes("/api/screenshot")) {
            return HttpClientResponse.fromWeb(
              request,
              new Response(new Uint8Array([137, 80, 78, 71])),
            );
          }
          if (request.url.endsWith("/shutdown")) {
            shutDown = true;
            booted = false;
            return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
          }
          if (shutDown && failListAfterShutdown) {
            return HttpClientResponse.fromWeb(
              request,
              new Response("Discovery busy", { status: 503 }),
            );
          }
          if (request.url.endsWith("/boot")) {
            yield* onBoot;
            booted = true;
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                bootError ? { ok: false, error: bootError } : { ok: true, serial: "emulator-5554" },
              ),
            );
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              simulators: [],
              emulators: booted
                ? [
                    {
                      id: "emulator-5554",
                      name: "Pixel_API_35",
                      platform: "android",
                      version: "Android 15",
                      booted: true,
                      physical: false,
                    },
                  ]
                : [],
            }),
          );
        }),
      ),
    ),
  );
  return { service, starts, agentStarts, agentStops, requests, settings };
});

describe("device setup consent", () => {
  it.effect(
    "preserves missing-runtime guidance and causes through manual and agent readiness",
    () =>
      Effect.gen(function* () {
        const underlying = new Error("private lookup diagnostics");
        const runtimeFailure = new NodeRuntimeUnavailableError({
          feature: "Local device support",
          cause: underlying,
        });
        const { service, settings, requests } = yield* fixture(
          Effect.void,
          undefined,
          false,
          runtimeFailure,
        );
        yield* Ref.update(settings, (current) => ({
          ...current,
          enableDeviceSupport: true,
          enableAgentDeviceAccess: true,
        }));
        for (const readiness of [service.readiness(), service.agentReadinessIfSupported()]) {
          const error = yield* readiness.pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "DeviceHostUnavailableError",
            reason: expect.stringContaining("Install Node.js"),
            cause: runtimeFailure,
          });
          expect(error.message).not.toContain(underlying.message);
        }
        expect((yield* service.state).hostStatuses[LOCAL_DEVICE_HOST_ID]).toMatchObject({
          status: "failed",
          detail: expect.stringContaining("Install Node.js"),
        });
        expect(requests).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("listing and provider startup do not start helpers before consent", () =>
    Effect.gen(function* () {
      const { service, starts, requests } = yield* fixture();
      expect((yield* service.list).hostStatus).toBe("disabled");
      expect(yield* service.readinessIfSupported()).toBeNull();
      const readiness = yield* service.readiness().pipe(Effect.result);
      expect(readiness._tag).toBe("Failure");
      expect(starts).toEqual([]);
      expect(requests).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "explicit setup discovers never-booted AVDs; disabling stops helpers and blocks agents",
    () =>
      Effect.gen(function* () {
        const { service, starts, settings } = yield* fixture();
        const state = yield* service.configure({ enabled: true });
        expect((yield* Ref.get(settings)).enableDeviceSupport).toBe(true);
        expect(state.devices.map((device) => [device.id, device.booted])).toEqual([
          ["Pixel_API_35", false],
        ]);
        expect(starts).toEqual(["start"]);
        const disabled = yield* service.configure({ enabled: false });
        expect(disabled.hostStatus).toBe("disabled");
        expect(disabled.devices).toEqual([]);
        expect((yield* Ref.get(settings)).enableDeviceSupport).toBe(false);
        expect(yield* service.readinessIfSupported()).toBeNull();
        expect(starts).toEqual(["start", "stop"]);
      }).pipe(Effect.scoped),
  );

  it.effect("boots a stopped Android AVD and uses its emulator serial without duplicating it", () =>
    Effect.gen(function* () {
      const { service, requests } = yield* fixture();
      yield* service.configure({ enabled: true });
      const session = yield* service.open({
        threadId: ThreadId.make("thread-1"),
        deviceId: "Pixel_API_35",
        platform: "android",
      });
      expect(session.deviceId).toBe("emulator-5554");
      expect(requests.filter((url) => url.endsWith("/boot"))).toHaveLength(1);
      const state = yield* service.state;
      expect(state.devices.map((device) => device.id)).toEqual(["emulator-5554"]);
      expect(state.bootingDevices).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("installs agent support only after the separate agent permission", () =>
    Effect.gen(function* () {
      const { service, agentStarts, agentStops, settings } = yield* fixture();
      yield* service.configure({ enabled: true });
      expect(agentStarts).toEqual([]);
      expect(yield* service.agentReadinessIfSupported()).toBeNull();

      yield* service.configure({ agentAccessEnabled: true });
      expect(agentStarts).toEqual(["start"]);
      expect((yield* Ref.get(settings)).enableAgentDeviceAccess).toBe(true);
      expect((yield* service.state).agentAccessEnabled).toBe(true);

      yield* service.configure({ agentAccessEnabled: false, onboardingCompleted: true });
      expect(agentStops).toEqual(["stop"]);
      expect((yield* service.state).onboardingCompleted).toBe(true);
      expect((yield* Ref.get(settings)).deviceOnboardingCompleted).toBe(true);
    }).pipe(Effect.scoped),
  );
});

it.effect("publishes boot progress and does not restore sessions after support is disabled", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const { service } = yield* fixture(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    );
    yield* service.configure({ enabled: true });
    const opening = yield* service
      .open({ threadId: ThreadId.make("thread-1"), deviceId: "Pixel_API_35", platform: "android" })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(started);
    expect((yield* service.state).bootingDevices?.map((device) => device.name)).toEqual([
      "Pixel_API_35",
    ]);
    yield* service.configure({ enabled: false });
    yield* Deferred.succeed(finish, undefined);
    expect((yield* Fiber.join(opening))._tag).toBe("Failure");
    const state = yield* service.state;
    expect(state.hostStatus).toBe("disabled");
    expect(state.devices).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(state.bootingDevices).toEqual([]);
  }).pipe(Effect.scoped),
);

describe("device discovery after server restart", () => {
  it.effect("captures an explicit device before any client lists devices", () =>
    Effect.gen(function* () {
      const { service, settings, requests } = yield* fixture();
      yield* Ref.update(settings, (current) => ({ ...current, enableDeviceSupport: true }));
      expect((yield* service.state).devices).toEqual([]);
      const capture = yield* service.screenshot({ deviceId: DeviceId.make("Pixel_API_35") });
      expect(capture.device.id).toBe("Pixel_API_35");
      expect(Array.from(capture.png)).toEqual([137, 80, 78, 71]);
      expect(requests.some((url) => url.endsWith("/api/devices"))).toBe(true);
    }).pipe(Effect.scoped),
  );
});

for (const [diagnostic, reason, message] of [
  ["Insufficient disk space at /private/user/path", "disk_space", "not enough free disk space"],
  ["Timed out spawning /private/user/command", "timeout", "did not become ready in time"],
  ["Unexpected failure: secret-token", "launch_failed", "could not start"],
] as const) {
  it.effect(`normalizes boot failure: ${reason}`, () =>
    Effect.gen(function* () {
      const { service } = yield* fixture(Effect.void, diagnostic);
      yield* service.configure({ enabled: true });
      const error = yield* service
        .open({
          threadId: ThreadId.make("boot-failure"),
          deviceId: "Pixel_API_35",
          platform: "android",
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("DeviceBootError");
      expect(error.message).toContain(message);
      expect(error.message).not.toContain(diagnostic);
      expect((yield* service.state).bootingDevices).toEqual([]);
    }).pipe(Effect.scoped),
  );
}

it.effect("keeps shutdown successful when subsequent discovery fails", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture(Effect.void, undefined, true);
    yield* service.configure({ enabled: true });
    const threadId = ThreadId.make("shutdown-refresh");
    const session = yield* service.open({
      threadId,
      deviceId: "Pixel_API_35",
      platform: "android",
    });
    yield* service.close({ threadId, deviceId: session.deviceId, shutdown: true });
    const state = yield* service.state;
    expect(state.sessions).toEqual([]);
    expect(state.devices.find((device) => device.id === session.deviceId)?.booted).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect.each(["shutdown", "close"] as const)(
  "%s releases iOS capture so reopening uses a fresh session",
  (operation) =>
    Effect.gen(function* () {
      const deviceId = DeviceId.make("11111111-1111-1111-1111-111111111111");
      const threadId = ThreadId.make("capture-recovery");
      let booted = true;
      let capture: number | null = null;
      let generation = 0;
      const ready: DeviceHost.DeviceHostReady = {
        nodePath: process.execPath,
        hub: { origin: "http://device.test" },
        helpers: { serveSimAxSettings: null, serveSimCli: null },
        run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
      };
      const host: DeviceHost.DeviceHost["Service"] = {
        id: LOCAL_DEVICE_HOST_ID,
        summary: Effect.succeed({
          id: LOCAL_DEVICE_HOST_ID,
          kind: "local",
          label: "Simulator host",
          platforms: [{ platform: "ios", available: true }],
          hubInstalled: true,
          agentDeviceInstalled: false,
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () => Effect.succeed(ready),
        ensureAgentReady: () => Effect.die("Agent access is not used in this test"),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          if (path === "/api/devices") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                emulators: [],
                simulators: [
                  {
                    id: deviceId,
                    name: "iPhone",
                    platform: "ios",
                    version: "26",
                    physical: false,
                    booted,
                  },
                ],
              }),
            );
          }
          if (path === "/vendor/serve-sim/grid/api/start") capture ??= ++generation;
          else if (path === "/vendor/serve-sim/grid/api/shutdown") {
            if (request.body._tag !== "Uint8Array") throw new Error("Missing shutdown body");
            expect(decodeJson(new TextDecoder().decode(request.body.body))).toEqual({
              udid: deviceId,
            });
            capture = null;
            booted = false;
          } else if (path === "/api/devices/shutdown") {
            // This route powers off without releasing serve-sim's cached capture.
            booted = false;
          } else if (path === "/api/devices/boot") booted = true;
          else throw new Error(`Unexpected hub path: ${path}`);
          return HttpClientResponse.fromWeb(request, Response.json({ ok: true, id: deviceId }));
        }),
      );
      const service = yield* makeWithHosts(new Map([[host.id, host]])).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const input = { threadId, deviceId, platform: "ios" as const };
      yield* service.open(input);
      expect(capture).toBe(1);
      if (operation === "shutdown") yield* service.shutdown(input);
      else yield* service.close({ threadId, deviceId, shutdown: true });
      expect(capture).toBeNull();
      expect((yield* service.state).sessions).toEqual([]);
      yield* service.open(input);
      expect(capture).toBe(2);
      expect((yield* service.state).sessions).toHaveLength(1);
    }).pipe(
      Effect.provide(ServerSettingsService.layerTest({ enableDeviceSupport: true })),
      Effect.scoped,
    ),
);

it.effect.each([
  { hubReports: "off", outcome: "succeeds" },
  { hubReports: "booted", outcome: "fails" },
  { hubReports: "missing", outcome: "fails" },
] as const)(
  "iOS shutdown $outcome when serve-sim rejects it and the hub reports the simulator $hubReports",
  ({ hubReports, outcome }) =>
    Effect.gen(function* () {
      const deviceId = DeviceId.make("22222222-2222-2222-2222-222222222222");
      const paths: string[] = [];
      // The device list is stale until shutdown re-reads it from the hub.
      let listed: "booted" | "off" | "missing" = "booted";
      const ready: DeviceHost.DeviceHostReady = {
        nodePath: process.execPath,
        hub: { origin: "http://device.test" },
        helpers: { serveSimAxSettings: null, serveSimCli: null },
        run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
      };
      const host: DeviceHost.DeviceHost["Service"] = {
        id: LOCAL_DEVICE_HOST_ID,
        summary: Effect.succeed({
          id: LOCAL_DEVICE_HOST_ID,
          kind: "local",
          label: "Simulator host",
          platforms: [{ platform: "ios", available: true }],
          hubInstalled: true,
          agentDeviceInstalled: false,
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () => Effect.succeed(ready),
        ensureAgentReady: () => Effect.die("Agent access is not used in this test"),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path === "/api/devices") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                emulators: [],
                simulators:
                  listed === "missing"
                    ? []
                    : [
                        {
                          id: deviceId,
                          name: "iPhone",
                          platform: "ios",
                          version: "26",
                          physical: false,
                          booted: listed === "booted",
                        },
                      ],
                // A partial listing still decodes; it must not read as "off".
                errors: listed === "missing" ? [{ message: "simctl list failed" }] : [],
              }),
            );
          }
          if (path === "/vendor/serve-sim/grid/api/shutdown") {
            // serve-sim runs `simctl shutdown` bare and returns its failure as-is.
            listed = hubReports;
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                { ok: false, error: "Unable to shutdown device in current state: Shutdown" },
                { status: 500 },
              ),
            );
          }
          throw new Error(`Unexpected hub path: ${path}`);
        }),
      );
      const service = yield* makeWithHosts(new Map([[host.id, host]])).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      yield* service.list;
      const exit = yield* Effect.exit(service.shutdown({ deviceId, platform: "ios" }));
      expect(paths.filter((path) => path.endsWith("shutdown"))).toEqual([
        "/vendor/serve-sim/grid/api/shutdown",
      ]);
      if (outcome === "succeeds") {
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(
          (yield* service.state).devices.find((device) => device.id === deviceId)?.booted,
        ).toBe(false);
      } else {
        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          (yield* service.state).devices.find((device) => device.id === deviceId)?.booted,
        ).toBe(true);
      }
    }).pipe(
      Effect.provide(ServerSettingsService.layerTest({ enableDeviceSupport: true })),
      Effect.scoped,
    ),
);

it.effect("retry keeps device and agent consent unchanged", () =>
  Effect.gen(function* () {
    const { service, starts, agentStarts } = yield* fixture();
    yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(starts).toEqual([]);
    expect(agentStarts).toEqual([]);
    yield* service.configure({ enabled: true });
    yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(agentStarts).toEqual([]);
    yield* service.configure({ agentAccessEnabled: true });
    const before = agentStarts.length;
    yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(agentStarts.length).toBe(before + 1);
  }).pipe(Effect.scoped),
);

it.effect("publishes update detail for the correct host", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture();
    const changes = yield* service.subscribe;
    yield* service.configure({ enabled: true });
    const states = yield* PubSub.takeAll(changes);
    expect(
      states.some(
        (state) => state.hostStatuses.local?.detail === "Updating device hub from 0.9.0 to 0.10.1…",
      ),
    ).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("host retry exposes actionable failure without internal IDs or diagnostics", () =>
  Effect.gen(function* () {
    const { service, settings } = yield* fixture(
      Effect.void,
      undefined,
      false,
      new DeviceHost.DeviceHostError({
        hostId: LOCAL_DEVICE_HOST_ID,
        step: "probe",
        cause: "private diagnostics",
      }),
    );
    yield* Ref.update(settings, (current) => ({ ...current, enableDeviceSupport: true }));
    const state = yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(state.hostStatuses[LOCAL_DEVICE_HOST_ID]).toEqual({
      status: "failed",
      detail: "Could not connect to this host over SSH.",
    });
  }).pipe(Effect.scoped),
);

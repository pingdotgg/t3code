import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DeviceId,
  LOCAL_DEVICE_HOST_ID,
  ThreadId,
  type DeviceServiceState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";

import { type DeviceService, make, stateStream } from "./DeviceService.ts";

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
) {
  const settings = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
  const starts: string[] = [];
  const agentStarts: string[] = [];
  const agentStops: string[] = [];
  const requests: string[] = [];
  let booted = false;
  let shutDown = false;
  const ready: DeviceHost.DeviceHostReady = {
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
        starts.push("start");
        yield* onPhase("starting");
        return ready;
      }),
    ensureAgentReady: (onPhase) =>
      Effect.gen(function* () {
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
  const service = yield* make.pipe(
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

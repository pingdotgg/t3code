import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
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
import type { DeviceHost, DeviceHostReady } from "./DeviceHost.ts";

import { type DeviceService, makeWithHost, stateStream } from "./DeviceService.ts";

const baseState: DeviceServiceState = {
  hosts: [],
  hostStatus: "idle",
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

const fixture = Effect.fn("fixture")(function* (onBoot: Effect.Effect<void> = Effect.void) {
  const settings = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
  const starts: string[] = [];
  const agentStarts: string[] = [];
  const agentStops: string[] = [];
  const requests: string[] = [];
  let booted = false;
  const ready: DeviceHostReady = {
    hub: { origin: "http://device.test" },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: () => Effect.succeed({ code: 0, stdout: "Pixel_API_35\n", stderr: "" }),
  };
  const host: DeviceHost = {
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
  const service = yield* makeWithHost(host).pipe(
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
          if (request.url.endsWith("/boot")) {
            yield* onBoot;
            booted = true;
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ ok: true, serial: "emulator-5554" }),
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

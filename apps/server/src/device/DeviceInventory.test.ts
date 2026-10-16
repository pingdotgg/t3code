import { expect, it } from "@effect/vitest";
import { LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";

const fixture = Effect.fnUntraced(function* (id: string) {
  const control = {
    enumeration: { code: 0, stdout: "Running_AVD\nStopped_AVD\nStopped_AVD", stderr: "" },
    pending: undefined as Effect.Effect<number> | undefined,
    summary: Effect.void,
    failReadiness: false,
  };
  const ready = {
    nodePath: process.execPath,
    hub: { origin: "http://fixture.test" },
    agentDevice: { baseUrl: "http://fixture.test", token: "fixture", entryPath: "/fixture" },
    run: () => Effect.sync(() => control.enumeration),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
  };
  const ensureReady = () =>
    control.failReadiness
      ? Effect.fail(new DeviceHost.DeviceHostError({ hostId: id, step: "probe", cause: "offline" }))
      : Effect.succeed(ready);
  const host: DeviceHost.DeviceHost["Service"] = {
    id,
    summary: Effect.suspend(() => control.summary).pipe(
      Effect.as({
        id,
        label: "Synthetic inventory fixture",
        kind: id === LOCAL_DEVICE_HOST_ID ? "local" : "ssh",
        platforms: [{ platform: "android", available: true }],
        hubInstalled: true,
        agentDeviceInstalled: true,
      }),
    ),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady,
    ensureAgentReady: (onPhase) => onPhase("starting").pipe(Effect.andThen(ensureReady)),
    current: Effect.succeed(ready),
    stop: Effect.void,
    stopAgent: Effect.void,
  };
  const devices = [
    { id: "ios", name: "iPhone", platform: "ios", physical: false },
    { id: "phone", name: "Pixel", platform: "android", physical: true },
    { id: "emulator-5554", name: "Running_AVD", platform: "android", physical: false },
  ].map((device) => ({ ...device, booted: true, version: "fixture" }));
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const status = yield* control.pending ?? Effect.succeed(200);
      return HttpClientResponse.fromWeb(
        request,
        Response.json(
          {
            simulators: devices.slice(0, 1),
            emulators: devices.slice(1),
          },
          { status },
        ),
      );
    }),
  );
  const hosts = new Map([[id, host]]);
  const service = yield* DeviceService.makeWithHosts(hosts).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(HttpClient.HttpClient, http),
  );
  return { service, control, hosts, host };
});
const settings = ServerSettings.layerTest({
  enableDeviceSupport: true,
  enableAgentDeviceAccess: true,
});
const hosts = [LOCAL_DEVICE_HOST_ID, "ssh-fixture"];

it.effect.each(hosts)("retains hub inventory on %s through AVD failures and recovery", (id) =>
  Effect.gen(function* () {
    const { service, control } = yield* fixture(id);
    for (const { code, stderr } of [127, 1, 255, 124].flatMap((code) =>
      ["", "synthetic-private-stderr"].map((stderr) => ({ code, stderr })),
    )) {
      control.enumeration = { code, stdout: "synthetic-private-stdout", stderr };
      const state = yield* service.list;
      expect(state.devices.map((device) => device.id)).toEqual(["ios", "phone", "emulator-5554"]);
      expect(state.hostStatuses[id]).toMatchObject({
        status: "ready",
        androidDiscoveryIncomplete: true,
      });
      expect(state.hostStatuses[id]?.detail).toBe(
        `Could not list Android virtual devices (emulator -list-avds, exit code ${code}). Discovered devices remain available.`,
      );
      if (id === LOCAL_DEVICE_HOST_ID)
        expect(state.hostStatusDetail).toBe(state.hostStatuses[id]?.detail);
    }
    control.enumeration = {
      code: 0,
      stdout: "Running_AVD\r\nStopped_AVD\nStopped_AVD\n",
      stderr: "",
    };
    for (const status of ["failed", "starting", "ready"] as const)
      yield* service.setHostStatus(id, { status });
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<number>();
    control.pending = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    const retry = yield* Effect.forkChild(service.retryHost(id));
    yield* Deferred.await(started);
    expect((yield* service.state).hostStatuses[id]).toEqual({
      status: "ready",
      androidDiscoveryIncomplete: true,
    });
    yield* Deferred.succeed(release, 200);
    const recovered = yield* Fiber.join(retry);
    expect(recovered.devices.map((device) => device.id)).toEqual([
      "ios",
      "phone",
      "emulator-5554",
      "Stopped_AVD",
    ]);
    expect(recovered.hostStatuses[id]).toEqual({ status: "ready" });
    if (id === LOCAL_DEVICE_HOST_ID) expect(recovered.hostStatusDetail).toBeUndefined();
  }).pipe(Effect.provide(settings)),
);

const races = hosts.flatMap((id) =>
  ["list", "retry"].flatMap((entry) =>
    ["older failure", "newer failure", "replacement", "removal", "disable"].map((race) => ({
      id,
      entry,
      race,
    })),
  ),
);
it.effect.each(races)("guards $entry against $race on $id", ({ id, entry, race }) =>
  Effect.gen(function* () {
    const { service, control, hosts, host } = yield* fixture(id);
    yield* service.list;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<number>();
    control.pending = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    const older = yield* Effect.forkChild(entry === "list" ? service.list : service.retryHost(id));
    yield* Deferred.await(started);
    control.pending = undefined;
    if (race === "newer failure") {
      control.pending = Effect.succeed(503);
      yield* service.list;
    } else if (race === "replacement" || race === "removal") {
      if (race === "replacement") hosts.set(id, { ...host });
      else hosts.delete(id);
      yield* service.withLifecycleLock(service.refreshHosts);
    } else if (race === "disable") yield* service.configure({ enabled: false });
    else yield* service.list;
    const expected = yield* service.state;
    yield* Deferred.succeed(release, race === "older failure" ? 503 : 200);
    yield* Fiber.join(older);
    expect(yield* service.state).toEqual(expected);
  }).pipe(Effect.provide(settings)),
);

it.effect.each(hosts)("guards delayed readiness publication on %s", (id) =>
  Effect.gen(function* () {
    const { service, control } = yield* fixture(id);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    // Pause before acquiring readiness's lifecycle lock; a newer failure must survive.
    control.summary = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    const older = yield* Effect.forkChild(service.list);
    yield* Deferred.await(started);
    control.summary = Effect.void;
    control.failReadiness = true;
    const expected = yield* service.list;
    control.failReadiness = false;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(older);
    expect(yield* service.state).toEqual(expected);
  }).pipe(Effect.provide(settings)),
);

it.effect("publishes local recovery after an overlapping earlier hub failure", () =>
  Effect.gen(function* () {
    const { service, control } = yield* fixture(LOCAL_DEVICE_HOST_ID);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<number>();
    control.pending = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    const older = yield* Effect.forkChild(service.list);
    yield* Deferred.await(started);
    const newerStarted = yield* Deferred.make<void>();
    const newerRelease = yield* Deferred.make<number>();
    control.pending = Deferred.succeed(newerStarted, undefined).pipe(
      Effect.andThen(Deferred.await(newerRelease)),
    );
    const newer = yield* Effect.forkChild(service.list);
    yield* Deferred.await(newerStarted);
    yield* Deferred.succeed(release, 503);
    yield* Fiber.join(older);
    expect((yield* service.state).hostStatus).toBe("failed");
    yield* Deferred.succeed(newerRelease, 200);
    yield* Fiber.join(newer);
    const recovered = yield* service.state;
    expect(recovered.hostStatus).toBe("ready");
    expect(recovered.hostStatusDetail).toBeUndefined();
    expect(recovered.hostStatuses[LOCAL_DEVICE_HOST_ID]).toEqual({ status: "ready" });
  }).pipe(Effect.provide(settings)),
);

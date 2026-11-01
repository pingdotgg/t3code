import { expect, it } from "@effect/vitest";
import { LOCAL_DEVICE_HOST_ID, ThreadId, type DeviceHostSummary } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import { releaseAgentDeviceSession } from "./AgentDeviceTarget.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import * as DeviceService from "./DeviceService.ts";

it.effect("keeps hosts independent when serials collide and another host fails", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            request.url.endsWith("/rpc")
              ? { result: { ok: true } }
              : {
                  simulators: [],
                  emulators: [
                    {
                      id: "emulator-5554",
                      name: "Pixel",
                      version: "36",
                      platform: "android",
                      booted: true,
                      physical: false,
                    },
                  ],
                },
          ),
        ),
      ),
    );
    const host = (id: string, failed = false): DeviceHost.DeviceHost["Service"] => {
      const run = (command: string) =>
        Effect.succeed({
          stdout: command === "emulator" ? "" : " V....D libx264",
          stderr: "",
          code: 0,
        });
      const ready: DeviceHost.DeviceHostAgentReady = {
        nodePath: process.execPath,
        hub: { origin: `http://${id}` },
        devices: makeDeviceHubOperations({
          hostId: id,
          origin: `http://${id}`,
          http,
          run,
          androidAvailable: Effect.succeed(true),
        }),
        agentDevice: { baseUrl: `http://${id}`, token: "test", entryPath: "/agent-device" },
        releaseAgentSession: releaseAgentDeviceSession(http, {
          baseUrl: `http://${id}`,
          token: "test",
        }),
        run,
        helpers: { serveSimAxSettings: null, serveSimCli: null },
      };
      return {
        id,
        label: id,
        summary: Effect.succeed({
          id,
          label: id,
          kind: id === "b" ? "ssh" : "local",
          hubInstalled: true,
          agentDeviceInstalled: true,
          platforms: id === "b" ? [] : [{ platform: "android", available: true }],
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () =>
          failed
            ? Effect.fail(
                new DeviceHost.DeviceHostError({
                  hostId: id,
                  step: "connect",
                  cause: new Error("offline"),
                }),
              )
            : Effect.succeed(ready),
        ensureAgentReady: () => Effect.succeed(ready),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
    };
    const hosts = new Map(["a", "b", "offline"].map((id) => [id, host(id, id === "offline")]));
    const writeStarted = yield* Deferred.make<void>();
    const finishWrite = yield* Deferred.make<void>();
    const order: string[] = [];
    const service = yield* DeviceService.makeWithHosts(hosts, undefined, () =>
      Effect.gen(function* () {
        order.push("write started");
        yield* Deferred.succeed(writeStarted, undefined);
        yield* Deferred.await(finishWrite);
        order.push("write finished");
        return "/host-config.json";
      }),
    ).pipe(Effect.provide(NodeCrypto.layer));
    expect(yield* service.agentReadinessIfSupported("b")).not.toBeNull();
    const listed = yield* service.list;
    expect(listed.devices.map((device) => device.hostId).sort()).toEqual(["a", "b"]);
    expect(listed.hostStatuses.offline?.status).toBe("failed");
    const threadId = ThreadId.make("thread");
    for (const hostId of ["a", "b"])
      yield* service.open({ threadId, hostId, deviceId: "emulator-5554", platform: "android" });
    yield* service.close({ threadId, hostId: "a", deviceId: "emulator-5554" });
    const state = yield* service.state;
    expect(state.devices).toHaveLength(2);
    expect(state.sessions.map((session) => session.hostId)).toEqual(["b"]);
    expect(state.hostStatuses.a?.status).toBe("ready");
    expect(state.hostStatuses.offline?.status).toBe("failed");
    const targeting = yield* service
      .agentTarget({ threadId, hostId: "b", deviceId: "emulator-5554" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(writeStarted);
    const replacing = yield* service
      .withLifecycleLock(
        Effect.gen(function* () {
          order.push("replace");
          hosts.set("b", host("b"));
          yield* service.refreshHosts;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.succeed(finishWrite, undefined);
    yield* Fiber.join(targeting);
    yield* Fiber.join(replacing);
    expect(order).toEqual(["write started", "write finished", "replace"]);
    const replaced = yield* service.state;
    expect(replaced.sessions).toEqual([]);
    expect(replaced.devices.map((device) => device.hostId)).toEqual(["a"]);
    expect(replaced.hostStatuses.b).toBeUndefined();
    yield* service.open({ threadId, hostId: "b", deviceId: "emulator-5554", platform: "android" });
    hosts.delete("b");
    yield* service.refreshHosts;
    yield* service.setHostStatus("b", { status: "ready" });
    expect((yield* service.state).hostStatuses.b).toBeUndefined();
    expect((yield* service.state).sessions).toEqual([]);
    yield* service.agentReadinessIfSupported("a");
    expect((yield* service.state).hostStatuses.a?.status).toBe("ready");
    yield* service.configure({ enabled: false });
    expect((yield* service.state).hostStatuses).toEqual({});
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({
        enableDeviceSupport: true,
        enableAgentDeviceAccess: true,
      }),
    ),
  ),
);

it.effect("starts other hosts while one host is still starting", () =>
  Effect.gen(function* () {
    const slowHost = yield* pausedHost("ensureReady", "slow");
    const fastHost = yield* pausedHost("ensureAgentReady", "fast");
    const hosts = new Map([slowHost.host, fastHost.host].map((host) => [host.id, host]));
    const service = yield* DeviceService.makeWithHosts(hosts).pipe(
      Effect.provide(NodeCrypto.layer),
    );
    const slow = yield* service.readiness("slow").pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(slowHost.started);
    expect((yield* service.readiness("fast")).hostId).toBe("fast");
    expect((yield* service.state).hostStatuses.fast?.status).toBe("ready");
    yield* service.configure({ enabled: false });
    yield* Deferred.succeed(slowHost.finish, undefined);
    const error = yield* Fiber.join(slow);
    expect(error._tag === "DeviceHostUnavailableError" && error.reason).toBe(
      "Device support was turned off while the host was starting.",
    );
    expect(slowHost.calls).toEqual(["stop", "stop"]);
    expect(fastHost.calls).toEqual(["stop"]);
    expect((yield* service.state).hostStatuses).toEqual({});
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true }))),
);

it.effect("stops a start that fails after device support was turned off before it began", () =>
  Effect.gen(function* () {
    const summaryEntered = yield* Deferred.make<void>();
    const finishSummary = yield* Deferred.make<void>();
    let pauseSummary = false;
    let running = false;
    const stops: string[] = [];
    const summary: DeviceHostSummary = {
      id: LOCAL_DEVICE_HOST_ID,
      label: "Local",
      kind: "local",
      hubInstalled: true,
      agentDeviceInstalled: false,
      platforms: [{ platform: "android", available: true }],
    };
    const run = () => Effect.succeed({ stdout: "", stderr: "", code: 0 });
    const ready: DeviceHost.DeviceHostReady = {
      nodePath: process.execPath,
      hub: { origin: "http://local" },
      devices: makeDeviceHubOperations({
        hostId: LOCAL_DEVICE_HOST_ID,
        origin: "http://local",
        http: HttpClient.make(() => Effect.die("unused")),
        run,
        androidAvailable: Effect.succeed(true),
      }),
      run,
      helpers: { serveSimAxSettings: null, serveSimCli: null },
    };
    const host: DeviceHost.DeviceHost["Service"] = {
      id: LOCAL_DEVICE_HOST_ID,
      label: "Local",
      summary: Effect.suspend(() =>
        pauseSummary
          ? Deferred.succeed(summaryEntered, undefined).pipe(
              Effect.andThen(Deferred.await(finishSummary)),
              Effect.as(summary),
            )
          : Effect.succeed(summary),
      ),
      platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
      ensureReady: () => Effect.succeed(ready),
      // Like LocalDeviceHost: the hub is up before the agent tools install fails.
      ensureAgentReady: () =>
        Effect.sync(() => {
          running = true;
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new DeviceHost.DeviceHostError({
                hostId: LOCAL_DEVICE_HOST_ID,
                step: "installing agent tools",
                cause: new Error("offline"),
              }),
            ),
          ),
        ),
      current: Effect.sync(() => (running ? ready : null)),
      stopAgent: Effect.void,
      stop: Effect.sync(() => {
        stops.push("stop");
        running = false;
      }),
    };
    const service = yield* DeviceService.makeWithHosts(new Map([[host.id, host]])).pipe(
      Effect.provide(NodeCrypto.layer),
    );
    pauseSummary = true;
    const starting = yield* service.agentReadinessIfSupported().pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(summaryEntered);
    yield* service.configure({ enabled: false });
    yield* Deferred.succeed(finishSummary, undefined);
    const error = yield* Fiber.join(starting);
    expect(error._tag === "DeviceHostUnavailableError" && error.reason).toBe(
      "Device support failed during installing agent tools.",
    );
    expect(stops).toEqual(["stop", "stop"]);
    expect(yield* service.currentReadiness()).toBeNull();
    const state = yield* service.state;
    expect(state.hostStatus).toBe("disabled");
    expect(state.hostStatuses).toEqual({});
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
    ),
  ),
);

const pausedHost = (
  pausing: "ensureReady" | "ensureAgentReady",
  id: string = LOCAL_DEVICE_HOST_ID,
) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const calls: string[] = [];
    const run = () => Effect.succeed({ stdout: "", stderr: "", code: 0 });
    const ready: DeviceHost.DeviceHostAgentReady = {
      nodePath: process.execPath,
      hub: { origin: `http://${id}` },
      devices: makeDeviceHubOperations({
        hostId: id,
        origin: `http://${id}`,
        http: HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ simulators: [], emulators: [] })),
          ),
        ),
        run,
        androidAvailable: Effect.succeed(false),
      }),
      agentDevice: null,
      run,
      helpers: { serveSimAxSettings: null, serveSimCli: null },
    };
    const start = (step: typeof pausing) =>
      step === pausing
        ? Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.as(ready),
          )
        : Effect.succeed(ready);
    const host: DeviceHost.DeviceHost["Service"] = {
      id,
      label: "Local",
      summary: Effect.succeed({
        id,
        label: "Local",
        kind: id === LOCAL_DEVICE_HOST_ID ? "local" : "ssh",
        hubInstalled: true,
        agentDeviceInstalled: true,
        platforms: [{ platform: "android", available: true }],
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
      ensureReady: () => start("ensureReady"),
      ensureAgentReady: () => start("ensureAgentReady"),
      current: Effect.succeed(null),
      stopAgent: Effect.sync(() => {
        calls.push("stopAgent");
      }),
      stop: Effect.sync(() => {
        calls.push("stop");
      }),
    };
    return { host, started, finish, calls };
  });

it.effect("stays disabled when device support is turned off while listing starts a host", () =>
  Effect.gen(function* () {
    const { host, started, finish, calls } = yield* pausedHost("ensureReady");
    const service = yield* DeviceService.makeWithHosts(new Map([[host.id, host]])).pipe(
      Effect.provide(NodeCrypto.layer),
    );
    const listing = yield* service.list.pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* service.configure({ enabled: false });
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(listing);
    expect(calls).toEqual(["stop", "stop"]);
    const state = yield* service.state;
    expect(state.hostStatus).toBe("disabled");
    expect(state.hostStatuses).toEqual({});
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true }))),
);

it.effect("retries without agent tools when agent access is turned off while they start", () =>
  Effect.gen(function* () {
    const { host, started, finish, calls } = yield* pausedHost("ensureAgentReady");
    const service = yield* DeviceService.makeWithHosts(new Map([[host.id, host]])).pipe(
      Effect.provide(NodeCrypto.layer),
    );
    const retrying = yield* service.retryHost(LOCAL_DEVICE_HOST_ID).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* service.configure({ agentAccessEnabled: false });
    yield* Deferred.succeed(finish, undefined);
    const state = yield* Fiber.join(retrying);
    expect(calls).toEqual(["stopAgent", "stopAgent"]);
    expect(state.agentAccessEnabled).toBe(false);
    expect(state.hostStatus).toBe("ready");
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
    ),
  ),
);

it.effect("keeps the replacement ready when an old host finishes starting", () =>
  Effect.gen(function* () {
    for (const fail of [false, true]) {
      const { host, started, finish, calls } = yield* pausedHost("ensureReady");
      const pendingHost: DeviceHost.DeviceHost["Service"] = {
        ...host,
        ensureReady: (onPhase) =>
          host.ensureReady(onPhase).pipe(
            Effect.tap(() => onPhase("starting")),
            Effect.filterOrFail(
              () => !fail,
              () =>
                new DeviceHost.DeviceHostError({
                  hostId: host.id,
                  step: "start",
                  cause: "offline",
                }),
            ),
          ),
      };
      const hosts = new Map([[host.id, pendingHost]]);
      const service = yield* DeviceService.makeWithHosts(hosts).pipe(
        Effect.provide(NodeCrypto.layer),
      );
      const listing = yield* service.list.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      hosts.set(host.id, { ...host });
      yield* service.setHostStatus(host.id, { status: "ready" });
      yield* Deferred.succeed(finish, undefined);
      const state = yield* Fiber.join(listing);
      expect(calls).toEqual(["stop"]);
      expect(state.hostStatuses[host.id]?.status).toBe("ready");
    }
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true }))),
);

it.effect("retries the hub when revoked agent startup fails", () =>
  Effect.gen(function* () {
    const { host, started, finish } = yield* pausedHost("ensureAgentReady");
    const failingHost = {
      ...host,
      ensureAgentReady: () =>
        host
          .ensureAgentReady(() => Effect.void)
          .pipe(
            Effect.andThen(
              Effect.fail(
                new DeviceHost.DeviceHostError({
                  hostId: host.id,
                  step: "agent",
                  cause: "offline",
                }),
              ),
            ),
          ),
    };
    const service = yield* DeviceService.makeWithHosts(new Map([[host.id, failingHost]])).pipe(
      Effect.provide(NodeCrypto.layer),
    );
    const retrying = yield* service.retryHost(host.id).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* service.configure({ agentAccessEnabled: false });
    yield* Deferred.succeed(finish, undefined);
    const state = yield* Fiber.join(retrying);
    expect(state.agentAccessEnabled).toBe(false);
    expect(state.hostStatuses[host.id]?.status).toBe("ready");
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
    ),
  ),
);

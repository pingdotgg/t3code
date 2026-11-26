import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { DeviceHostId, DeviceId, LOCAL_DEVICE_HOST_ID, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import * as DeviceService from "./DeviceService.ts";

const deviceId = DeviceId.make("11111111-1111-1111-1111-111111111111");
const target = { hostId: LOCAL_DEVICE_HOST_ID, deviceId, platform: "ios" as const };
const threadId = ThreadId.make("viewing-simulator");
const otherHostId = DeviceHostId.make("other-host");

const fixture = Effect.fn("shutdownFixture")(function* (rejectShutdown: boolean) {
  const requested = yield* Deferred.make<void>();
  const respond = yield* Deferred.make<void>();
  const acknowledged = yield* Deferred.make<void>();
  const localOrigin = "http://local.device.test";
  const booted = new Map<string, boolean>();
  const staleList = {
    holdNext: false,
    captured: yield* Deferred.make<void>(),
    respond: yield* Deferred.make<void>(),
  };
  let binds = 0;
  const releases: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const { origin, pathname: path } = new URL(request.url);
      if (path.endsWith("/shutdown")) {
        yield* Deferred.succeed(requested, undefined);
        yield* Deferred.await(respond);
        if (!rejectShutdown) booted.set(origin, false);
        return HttpClientResponse.fromWeb(request, Response.json({ ok: !rejectShutdown }));
      }
      const simulator = {
        id: deviceId,
        name: "iPhone",
        platform: "ios",
        version: "26",
        physical: false,
        booted: booted.get(origin) ?? true,
      };
      if (path === "/api/devices" && origin === localOrigin && staleList.holdNext) {
        staleList.holdNext = false;
        yield* Deferred.succeed(staleList.captured, undefined);
        yield* Deferred.await(staleList.respond);
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json(
          path === "/api/devices" ? { emulators: [], simulators: [simulator] } : { ok: true },
        ),
      );
    }),
  );
  const makeHost = (id: DeviceHostId): DeviceHost.DeviceHost["Service"] => {
    const run = () => Effect.succeed({ code: 0, stdout: "", stderr: "" });
    const origin = id === LOCAL_DEVICE_HOST_ID ? localOrigin : "http://other.device.test";
    const devices = makeDeviceHubOperations({
      hostId: id,
      origin,
      http,
      run,
      platformAvailable: () => Effect.succeed(true),
    });
    const ready: DeviceHost.DeviceHostReady = {
      nodePath: process.execPath,
      hub: { origin },
      devices: {
        ...devices,
        shutdown: (device) =>
          devices
            .shutdown(device)
            .pipe(Effect.tap(() => Deferred.succeed(acknowledged, undefined))),
      },
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      run,
    };
    return {
      id,
      label: id,
      summary: Effect.succeed({
        id,
        kind: "local",
        label: id,
        platforms: [{ platform: "ios", available: true }],
        hubInstalled: true,
        agentDeviceInstalled: false,
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
      ensureReady: () => Effect.succeed(ready),
      ensureAgentReady: () => Effect.die("Unexpected agent readiness request"),
      current: Effect.succeed(ready),
      stopAgent: Effect.void,
      stop: Effect.void,
    };
  };
  const service = yield* DeviceService.makeWithHosts(
    new Map([LOCAL_DEVICE_HOST_ID, otherHostId].map((id) => [id, makeHost(id)])),
    undefined,
    undefined,
    undefined,
    {
      bind: ({ session }) =>
        Effect.sync(() => {
          binds += 1;
          return session;
        }),
      prune: () => Effect.void,
      release: (launcher) => Effect.sync(() => void releases.push(launcher)),
    },
  ).pipe(Effect.provide(NodeCrypto.layer));
  yield* service.open({ ...target, threadId });
  const bind = service.agentLauncher({ ...target, threadId, targetArgs: [] });
  const launcher = Option.getOrThrow(yield* bind);
  return {
    service,
    bind,
    binds: () => binds,
    launcher,
    releases,
    requested,
    respond,
    acknowledged,
    staleList,
  };
});

it.effect.each(["stop", "close"] as const)(
  "releases a reused launcher when its view closes after a rejected %s",
  (operation) =>
    Effect.gen(function* () {
      const { service, launcher, requested, respond, releases } = yield* fixture(true);
      const stopping = yield* Effect.forkChild(
        Effect.flip(
          operation === "stop"
            ? service.shutdown(target)
            : service.close({ ...target, threadId, shutdown: true }),
        ),
      );
      yield* Deferred.await(requested);
      yield* Deferred.succeed(respond, undefined);
      expect(yield* Fiber.join(stopping)).toMatchObject({
        _tag: "DeviceOperationError",
        operation: "shutdown",
        reason: "hub_rejected",
      });
      expect((yield* service.state).sessions.map((session) => session.threadId)).toEqual([
        threadId,
      ]);
      expect(releases).toEqual([launcher]);
      // A caller can reuse the existing launcher without asking T3 to bind it again.
      yield* service.close({ ...target, threadId });
      expect(releases).toEqual([launcher, launcher]);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true }))),
);

it.effect("commits a successful stop during cancellation and rejects a late launcher bind", () =>
  Effect.gen(function* () {
    const { service, bind, binds, launcher, releases, requested, respond, acknowledged } =
      yield* fixture(false);
    const stopping = yield* Effect.forkChild(service.shutdown(target));
    yield* Deferred.await(requested);

    const late = yield* Effect.forkChild(bind, { startImmediately: true });
    expect(binds()).toBe(1);
    yield* service.readiness(otherHostId);

    const updates = yield* service.subscribe;
    yield* service.withLifecycleLock(
      Effect.gen(function* () {
        yield* Deferred.succeed(respond, undefined);
        yield* Deferred.await(acknowledged);
        yield* Effect.sync(() => stopping.interruptUnsafe());
      }),
    );
    yield* Fiber.await(stopping);
    const [stopped] = yield* PubSub.takeUpTo(updates, 1);
    expect(stopped?.devices.find((device) => device.id === deviceId)?.booted).toBe(false);
    expect(stopped?.sessions).toEqual([]);
    expect(yield* Fiber.join(late)).toEqual(Option.none());
    expect(releases).toEqual([launcher]);
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true }))),
);

it.effect("does not publish an older listing after a confirmed stop", () =>
  Effect.gen(function* () {
    const { service, requested, respond, staleList } = yield* fixture(false);
    const stopping = yield* Effect.forkChild(service.shutdown(target));
    yield* Deferred.await(requested);

    staleList.holdNext = true;
    const listing = yield* Effect.forkChild(service.list);
    yield* Deferred.await(staleList.captured);
    yield* Deferred.succeed(respond, undefined);
    yield* Fiber.join(stopping);

    const updates = yield* service.subscribe;
    yield* Deferred.succeed(staleList.respond, undefined);
    const state = yield* Fiber.join(listing);
    const localDeviceBooted = (snapshot: typeof state) =>
      snapshot.devices.find((device) => device.hostId === target.hostId && device.id === deviceId)
        ?.booted;
    expect(localDeviceBooted(state)).toBe(false);
    expect((yield* PubSub.takeUpTo(updates, 10)).map(localDeviceBooted)).not.toContain(true);
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true }))),
);

it.effect("can reopen one device while closing a thread whose other device is stopping", () =>
  Effect.gen(function* () {
    const { service, requested, respond } = yield* fixture(false);
    const other = { ...target, hostId: otherHostId };
    yield* service.open({ ...other, threadId });
    const stopping = yield* Effect.forkChild(service.shutdown(other));
    yield* Deferred.await(requested);
    const closing = yield* Effect.forkChild(service.close({ threadId }), {
      startImmediately: true,
    });
    const reopeningThread = ThreadId.make("reopening");
    const reopened = yield* service
      .open({ ...target, threadId: reopeningThread })
      .pipe(Effect.ensuring(Deferred.succeed(respond, undefined)));
    yield* Fiber.join(stopping);
    yield* Fiber.join(closing);
    expect((yield* service.state).sessions).toEqual([reopened]);
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true }))),
);

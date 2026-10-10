import { expect, it } from "@effect/vitest";
import { LOCAL_DEVICE_HOST_ID, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";

const emulatorFailures = [
  { code: 127, stderr: "sh: exec: emulator: not found" },
  { code: 1, stderr: "emulator: SDK directory is unreadable" },
  { code: 255, stderr: "ssh: connection reset by peer" },
];

const refreshFailureFixture = Effect.fn("refreshFailureFixture")(function* (hostId: string) {
  const control = {
    hubStatus: 200,
    pendingHub: undefined as Effect.Effect<number> | undefined,
    pendingSummary: undefined as Effect.Effect<void> | undefined,
    failReadiness: false,
  };
  const ready = {
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    agentDevice: { baseUrl: "http://device.test", token: "test", entryPath: "/agent-device" },
    run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
  };
  const ensureReady = () =>
    control.failReadiness
      ? Effect.fail(
          new DeviceHost.DeviceHostError({ hostId, step: "probe", cause: new Error("offline") }),
        )
      : Effect.succeed(ready);
  const host: DeviceHost.DeviceHost["Service"] = {
    id: hostId,
    summary: Effect.gen(function* () {
      if (control.pendingSummary) yield* control.pendingSummary;
      return {
        id: hostId,
        label: hostId,
        kind: hostId === LOCAL_DEVICE_HOST_ID ? ("local" as const) : ("ssh" as const),
        hubInstalled: true,
        agentDeviceInstalled: true,
        platforms: [{ platform: "android" as const, available: true }],
      };
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady,
    ensureAgentReady: ensureReady,
    current: Effect.succeed(ready),
    stopAgent: Effect.void,
    stop: Effect.void,
  };
  const hosts = new Map([[hostId, host]]);
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const status = yield* control.pendingHub ?? Effect.succeed(control.hubStatus);
      return HttpClientResponse.fromWeb(
        request,
        Response.json(
          {
            simulators: [],
            emulators: [
              {
                id: "phone-1",
                name: "Physical Pixel",
                version: "36",
                platform: "android",
                booted: true,
                physical: true,
              },
            ],
          },
          { status },
        ),
      );
    }),
  );
  const service = yield* DeviceService.makeWithHosts(hosts).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(HttpClient.HttpClient, http),
  );
  return { service, control, hosts, host };
});

const refreshEntries = [LOCAL_DEVICE_HOST_ID, "mac-ssh"].flatMap((hostId) =>
  ["list", "retry"].map((entry) => ({ hostId, entry })),
);

it.effect("restores both local statuses when newer recovery follows an older failure", () =>
  Effect.gen(function* () {
    const { service, control } = yield* refreshFailureFixture(LOCAL_DEVICE_HOST_ID);
    const olderStarted = yield* Deferred.make<void>();
    const releaseOlder = yield* Deferred.make<number>();
    control.pendingHub = Deferred.succeed(olderStarted, undefined).pipe(
      Effect.andThen(Deferred.await(releaseOlder)),
    );
    const older = yield* Effect.forkChild(service.list);
    yield* Deferred.await(olderStarted);
    const newerStarted = yield* Deferred.make<void>();
    const releaseNewer = yield* Deferred.make<number>();
    control.pendingHub = Deferred.succeed(newerStarted, undefined).pipe(
      Effect.andThen(Deferred.await(releaseNewer)),
    );
    const newer = yield* Effect.forkChild(service.list);
    yield* Deferred.await(newerStarted);
    yield* Deferred.succeed(releaseOlder, 503);
    yield* Fiber.join(older);
    const failed = yield* service.state;
    expect(failed.hostStatus).toBe("failed");
    expect(failed.hostStatuses[LOCAL_DEVICE_HOST_ID]?.status).toBe("failed");
    expect(failed.hostStatusDetail).toBeDefined();
    yield* Deferred.succeed(releaseNewer, 200);
    yield* Fiber.join(newer);
    const recovered = yield* service.state;
    expect(recovered.hostStatuses[LOCAL_DEVICE_HOST_ID]).toEqual({ status: "ready" });
    expect(recovered.hostStatus).toBe("ready");
    expect(recovered.hostStatusDetail).toBeUndefined();
    expect(recovered.devices.map((device) => device.id)).toEqual(["phone-1"]);
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true }))),
);

it.effect.each(refreshEntries)(
  "ignores an older $entry failure on $hostId after newer recovery",
  ({ hostId, entry }) =>
    Effect.gen(function* () {
      const { service, control } = yield* refreshFailureFixture(hostId);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<number>();
      control.pendingHub = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const older = yield* Effect.forkChild(
        entry === "list" ? service.list : service.retryHost(hostId),
      );
      yield* Deferred.await(started);
      control.pendingHub = undefined;
      const newer = yield* service.list;
      yield* Deferred.succeed(release, 503);
      yield* Fiber.join(older);
      expect(yield* service.state).toEqual(newer);
      expect(newer.hostStatuses[hostId]).toEqual({ status: "ready" });
      expect(newer.devices.map((device) => device.id)).toEqual(["phone-1"]);
      if (hostId === LOCAL_DEVICE_HOST_ID) {
        expect(newer.hostStatus).toBe("ready");
        expect(newer.hostStatusDetail).toBeUndefined();
      }
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          enableDeviceSupport: true,
          enableAgentDeviceAccess: true,
        }),
      ),
    ),
);

it.effect.each(refreshEntries)(
  "preserves a newer $entry failure on $hostId when older discovery succeeds",
  ({ hostId, entry }) =>
    Effect.gen(function* () {
      const { service, control } = yield* refreshFailureFixture(hostId);
      const initial = yield* service.list;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<number>();
      control.pendingHub = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const older = yield* Effect.forkChild(service.list);
      yield* Deferred.await(started);
      control.pendingHub = undefined;
      control.hubStatus = 503;
      const newer = yield* entry === "list" ? service.list : service.retryHost(hostId);
      expect(newer.hostStatuses[hostId]?.status).toBe("failed");
      expect(newer.devices).toEqual(initial.devices);
      if (hostId === LOCAL_DEVICE_HOST_ID) {
        expect(newer.hostStatus).toBe("failed");
        expect(newer.hostStatusDetail).toBe(newer.hostStatuses[hostId]?.detail);
      }
      yield* Deferred.succeed(release, 200);
      yield* Fiber.join(older);
      expect(yield* service.state).toEqual(newer);
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          enableDeviceSupport: true,
          enableAgentDeviceAccess: true,
        }),
      ),
    ),
);

it.effect.each(refreshEntries)(
  "ignores an older $entry readiness failure on $hostId after recovery",
  ({ hostId, entry }) =>
    Effect.gen(function* () {
      const { service, control } = yield* refreshFailureFixture(hostId);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      control.pendingSummary = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const older = yield* Effect.forkChild(
        entry === "list" ? service.list : service.retryHost(hostId),
      );
      yield* Deferred.await(started);
      control.pendingSummary = undefined;
      const newer = yield* service.list;
      control.failReadiness = true;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(older);
      expect(yield* service.state).toEqual(newer);
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          enableDeviceSupport: true,
          enableAgentDeviceAccess: false,
        }),
      ),
    ),
);

it.effect.each(["disabled", "replaced"])(
  "ignores an in-flight discovery failure after the host is %s",
  (transition) =>
    Effect.gen(function* () {
      const hostId = LOCAL_DEVICE_HOST_ID;
      const { service, control, hosts, host } = yield* refreshFailureFixture(hostId);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<number>();
      control.pendingHub = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const older = yield* Effect.forkChild(service.list);
      yield* Deferred.await(started);
      control.pendingHub = undefined;
      if (transition === "disabled") yield* service.configure({ enabled: false });
      else {
        yield* service.withLifecycleLock(
          Effect.gen(function* () {
            hosts.set(hostId, { ...host });
            yield* service.refreshHosts;
          }),
        );
        yield* service.list;
      }
      const current = yield* service.state;
      yield* Deferred.succeed(release, 503);
      yield* Fiber.join(older);
      expect(yield* service.state).toEqual(current);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true }))),
);

it.effect.each(
  [LOCAL_DEVICE_HOST_ID, "mac-ssh"].flatMap((hostId) =>
    emulatorFailures.map((failure) => ({ hostId, code: failure.code, failure })),
  ),
)(
  "retains partial discovery and diagnostics on $hostId after emulator exit $code",
  ({ hostId, failure }) =>
    Effect.gen(function* () {
      let enumeration = { ...failure, stdout: "incomplete-output-must-not-be-an-avd" };
      let pendingEnumeration: Effect.Effect<typeof enumeration> | undefined;
      let hubErrors = [{ message: "One simulator could not be inspected" }];
      let includeAndroidDevices = true;
      const ready = {
        nodePath: process.execPath,
        hub: { origin: "http://device.test" },
        agentDevice: {
          baseUrl: "http://device.test",
          token: "test",
          entryPath: "/agent-device",
        },
        run: () => pendingEnumeration ?? Effect.succeed(enumeration),
        helpers: { serveSimAxSettings: null, serveSimCli: null },
      };
      const host: DeviceHost.DeviceHost["Service"] = {
        id: hostId,
        summary: Effect.succeed({
          id: hostId,
          label: hostId,
          kind: hostId === LOCAL_DEVICE_HOST_ID ? "local" : "ssh",
          hubInstalled: true,
          agentDeviceInstalled: true,
          platforms: [
            { platform: "android", available: true },
            { platform: "ios", available: true },
          ],
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () => Effect.succeed(ready),
        ensureAgentReady: () => Effect.succeed(ready),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              simulators: [
                {
                  id: "ios-1",
                  name: "iPhone",
                  version: "26",
                  platform: "ios",
                  booted: true,
                  physical: false,
                },
              ],
              emulators: includeAndroidDevices
                ? [
                    {
                      id: "phone-1",
                      name: "Physical Pixel",
                      version: "36",
                      platform: "android",
                      booted: true,
                      physical: true,
                    },
                    {
                      id: "emulator-5554",
                      name: "Running_AVD",
                      version: "36",
                      platform: "android",
                      booted: true,
                      physical: false,
                    },
                  ]
                : [],
              errors: hubErrors,
            }),
          ),
        ),
      );
      const service = yield* DeviceService.makeWithHosts(new Map([[hostId, host]])).pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const partial = yield* service.list;
      expect(partial.devices.map((device) => device.id)).toEqual([
        "ios-1",
        "phone-1",
        "emulator-5554",
      ]);
      expect(partial.hostStatuses[hostId]).toEqual({
        status: "ready",
        detail: expect.stringContaining(failure.stderr),
        androidDiscoveryIncomplete: true,
      });
      expect(partial.hostStatuses[hostId]?.detail).toContain(`exit code ${failure.code}`);
      expect(partial.hostStatuses[hostId]?.detail).toContain(hubErrors[0]!.message);
      if (hostId === LOCAL_DEVICE_HOST_ID)
        expect(partial.hostStatusDetail).toBe(partial.hostStatuses[hostId]?.detail);

      enumeration = {
        code: failure.code,
        stdout: "",
        stderr: "verbose-prefix" + "x".repeat(3000) + failure.stderr,
      };
      const bounded = yield* service.list;
      expect(bounded.devices).toEqual(partial.devices);
      expect(bounded.hostStatuses[hostId]?.detail).not.toContain("verbose-prefix");
      expect(bounded.hostStatuses[hostId]?.detail?.endsWith(failure.stderr)).toBe(true);
      expect(bounded.hostStatuses[hostId]?.detail?.length).toBeLessThan(2300);

      enumeration = { code: failure.code, stdout: "PANIC: broken SDK\n", stderr: "" };
      const stdoutOnly = yield* service.list;
      expect(stdoutOnly.devices).toEqual(partial.devices);
      expect(stdoutOnly.hostStatuses[hostId]?.detail).toContain("PANIC: broken SDK");

      includeAndroidDevices = false;
      hubErrors = [];
      const incomplete = yield* service.list;
      expect(incomplete.devices.map((device) => device.id)).toEqual(["ios-1"]);
      expect(incomplete.hostStatuses[hostId]).toEqual({
        status: "ready",
        detail: expect.stringContaining("emulator -list-avds"),
        androidDiscoveryIncomplete: true,
      });

      enumeration = { code: 0, stdout: "", stderr: "" };
      hubErrors = [{ message: "One iOS simulator could not be inspected" }];
      const iosWarning = yield* service.list;
      expect(iosWarning.hostStatuses[hostId]).toEqual({
        status: "ready",
        detail: hubErrors[0]!.message,
      });
      hubErrors = [];
      const empty = yield* service.list;
      expect(empty.devices).toEqual(incomplete.devices);
      expect(empty.hostStatuses[hostId]).toEqual({ status: "ready" });
      if (hostId === LOCAL_DEVICE_HOST_ID) expect(empty.hostStatusDetail).toBeUndefined();

      includeAndroidDevices = true;
      enumeration = {
        code: 0,
        stderr: "",
        stdout: "Running_AVD\r\nStopped_AVD\r\nStopped_AVD\r\n",
      };
      hubErrors = [];
      const recovered = yield* service.list;
      expect(recovered.hostStatuses[hostId]).toEqual({ status: "ready" });
      expect(recovered.devices.map((device) => device.id)).toEqual([
        "ios-1",
        "phone-1",
        "emulator-5554",
        "Stopped_AVD",
      ]);
      expect(recovered.devices.at(-1)).toMatchObject({
        hostId,
        booted: false,
        physical: false,
      });
      if (hostId === LOCAL_DEVICE_HOST_ID) expect(recovered.hostStatusDetail).toBeUndefined();

      const olderStarted = yield* Deferred.make<void>();
      const releaseOlder = yield* Deferred.make<typeof enumeration>();
      includeAndroidDevices = false;
      pendingEnumeration = Deferred.succeed(olderStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseOlder)),
      );
      const older = yield* Effect.forkChild(service.list);
      yield* Deferred.await(olderStarted);
      pendingEnumeration = undefined;
      includeAndroidDevices = true;
      const newer = yield* service.list;
      yield* Deferred.succeed(releaseOlder, { ...failure, stdout: "" });
      yield* Fiber.join(older);
      expect((yield* service.state).devices).toEqual(newer.devices);
      expect((yield* service.state).hostStatuses[hostId]).toEqual({ status: "ready" });
      if (hostId === LOCAL_DEVICE_HOST_ID)
        expect((yield* service.state).hostStatusDetail).toBeUndefined();
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true }))),
);

it.effect("keeps hosts independent when serials collide and another host fails", () =>
  Effect.gen(function* () {
    const host = (id: string, failed = false): DeviceHost.DeviceHost["Service"] => {
      const ready = {
        nodePath: process.execPath,
        hub: { origin: `http://${id}` },
        agentDevice: { baseUrl: `http://${id}`, token: "test", entryPath: "/agent-device" },
        run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
        helpers: { serveSimAxSettings: null, serveSimCli: null },
      };
      return {
        id,
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
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
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
          }),
        ),
      ),
    );
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
    ).pipe(Effect.provide(NodeCrypto.layer), Effect.provideService(HttpClient.HttpClient, http));
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

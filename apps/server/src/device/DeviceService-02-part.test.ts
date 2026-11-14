import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DeviceBootError,
  DeviceId,
  DeviceOperationError,
  LOCAL_DEVICE_HOST_ID,
  ThreadId,
  type DeviceSummary,
  type ServerSettings as Settings,
  type SshDeviceHostConfig,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import { NodeRuntimeUnavailableError } from "@t3tools/shared/nodeRuntime";

import * as DeviceService from "./DeviceService.ts";
import { agentDeviceSession, releaseAgentDeviceSession } from "./AgentDeviceTarget.ts";









// The hub reports `error` as a util.inspect of Node's exec error.


// regression: #22012 report Android emulator boot failures













import { fixture, layerSecretResolver, decodeJson } from "./DeviceService-fixtures.testkit.ts";
it.effect.each(["shutdown", "close"] as const)(
  "%s releases iOS capture and the session's launcher so reopening uses a fresh session",
  (operation) =>
    Effect.gen(function* () {
      const deviceId = DeviceId.make("11111111-1111-1111-1111-111111111111");
      const threadId = ThreadId.make("capture-recovery");
      let booted = true;
      let capture: number | null = null;
      let generation = 0;
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
      const run = () => Effect.succeed({ code: 0, stdout: "", stderr: "" });
      const ready: DeviceHost.DeviceHostReady = {
        nodePath: process.execPath,
        hub: { origin: "http://device.test" },
        devices: makeDeviceHubOperations({
          hostId: LOCAL_DEVICE_HOST_ID,
          origin: "http://device.test",
          http,
          run,
          androidAvailable: Effect.succeed(true),
        }),
        helpers: { serveSimAxSettings: null, serveSimCli: null },
        run,
      };
      const host: DeviceHost.DeviceHost["Service"] = {
        id: LOCAL_DEVICE_HOST_ID,
        label: "This machine",
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
      const launchers = new Set(["t3-from-a-previous-run"]);
      const released: Array<[string, boolean]> = [];
      // Whether the device was still on when each session was released.
      const releasedWhileBooted: Array<boolean> = [];
      let pauseBind: { entered: Deferred.Deferred<void>; proceed: Deferred.Deferred<void> } | null =
        null;
      const service = yield* DeviceService.makeWithHosts(
        new Map([[host.id, host]]),
        undefined,
        undefined,
        undefined,
        {
          bind: ({ session }) =>
            Effect.gen(function* () {
              if (pauseBind) {
                yield* Deferred.succeed(pauseBind.entered, undefined);
                yield* Deferred.await(pauseBind.proceed);
              }
              launchers.add(session);
              return session;
            }),
          prune: (live) =>
            Effect.sync(() => {
              for (const session of launchers) if (!live.has(session)) launchers.delete(session);
            }),
          // Records whether the launcher still existed, since its close runs through it.
          release: (launcher) =>
            Effect.sync(() => {
              released.push([launcher, launchers.has(launcher)]);
              releasedWhileBooted.push(booted);
            }),
        },
      ).pipe(Effect.provide(NodeCrypto.layer));
      expect(launchers).toEqual(new Set());
      const input = { threadId, deviceId, platform: "ios" as const };
      const other = { ...input, threadId: ThreadId.make("capture-recovery-other") };
      const target = (thread: ThreadId) => ({
        threadId: thread,
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId,
      });
      const bind = Effect.fnUntraced(function* (open: typeof input) {
        yield* service.open(open);
        yield* service.agentLauncher({ ...target(open.threadId), targetArgs: [] });
        return yield* agentDeviceSession(open.threadId, LOCAL_DEVICE_HOST_ID, deviceId);
      }, Effect.provide(NodeCrypto.layer));
      const session = yield* bind(input);
      yield* bind(other);
      expect(capture).toBe(1);
      expect(launchers.size).toBe(2);
      if (operation === "shutdown") yield* service.shutdown(input);
      else yield* service.close({ threadId, deviceId, shutdown: true });
      expect(capture).toBeNull();
      expect((yield* service.state).sessions).toEqual([]);
      expect(launchers).toEqual(new Set());
      // Retiring a session ends its agent-device session too, which releases the device claim.
      // Powering the device off retires the other thread's session on it as well.
      const firstOther = yield* agentDeviceSession(
        other.threadId,
        LOCAL_DEVICE_HOST_ID,
        deviceId,
      ).pipe(Effect.provide(NodeCrypto.layer));
      expect(new Set(released.map(([launcher]) => launcher))).toEqual(
        new Set([session, firstOther]),
      );
      expect(released.every(([, existed]) => existed)).toBe(true);
      // agent-device can close the session's app only while the device is on.
      expect(releasedWhileBooted).toEqual([true, true]);
      // A device_open that was still preparing when the close landed.
      expect(yield* service.agentLauncher({ ...target(threadId), targetArgs: [] })).toEqual(
        Option.none(),
      );
      expect(launchers).toEqual(new Set());
      expect(yield* bind(input)).toBe(session);
      // Reopening the same device ends nothing.
      expect(released).toHaveLength(2);
      expect(capture).toBe(2);
      expect((yield* service.state).sessions).toHaveLength(1);
      const otherSession = yield* bind(other);
      yield* service.close({ threadId: other.threadId });
      expect(launchers).toEqual(new Set([session]));
      expect(released.slice(2)).toEqual([[otherSession, true]]);
      expect(otherSession).not.toBe(session);
      // A caller interrupted after retirement committed, while a bind holds the launcher lock.
      pauseBind = { entered: yield* Deferred.make<void>(), proceed: yield* Deferred.make<void>() };
      const binding = yield* Effect.forkChild(
        service.agentLauncher({ ...target(threadId), targetArgs: [] }),
      );
      yield* Deferred.await(pauseBind.entered);
      const updates = yield* service.subscribe;
      const retiring = yield* Effect.forkChild(
        operation === "shutdown" ? service.shutdown(input) : service.close({ threadId }),
      );
      expect((yield* PubSub.take(updates)).sessions).toEqual([]);
      yield* service.refreshHosts;
      expect((yield* service.state).sessions).toEqual([]);
      yield* Effect.sync(() => retiring.interruptUnsafe());
      yield* Deferred.succeed(pauseBind.proceed, undefined);
      yield* Fiber.join(binding);
      yield* Fiber.await(retiring);
      expect(launchers).toEqual(new Set());
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);
it.effect("leaves a session its host leases to every thread open when one thread closes", () =>
  Effect.gen(function* () {
    const deviceId = DeviceId.make("33333333-3333-3333-3333-333333333333");
    const http = HttpClient.make((request) =>
      Effect.sync(() =>
        new URL(request.url).pathname === "/api/devices"
          ? HttpClientResponse.fromWeb(
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
                    booted: true,
                  },
                ],
              }),
            )
          : HttpClientResponse.fromWeb(request, Response.json({ ok: true, id: deviceId })),
      ),
    );
    const run = () => Effect.succeed({ code: 0, stdout: "", stderr: "" });
    const ready: DeviceHost.DeviceHostAgentReady = {
      nodePath: process.execPath,
      hub: { origin: "http://device.test" },
      devices: {
        ...makeDeviceHubOperations({
          hostId: LOCAL_DEVICE_HOST_ID,
          origin: "http://device.test",
          http,
          run,
          androidAvailable: Effect.succeed(true),
        }),
        agentEndpoint: () =>
          Effect.succeed({
            baseUrl: "http://agent.test",
            token: "agent-token",
            agentDeviceId: null,
            session: "lease-session",
          }),
      },
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      run,
      agentDevice: null,
    };
    const host: DeviceHost.DeviceHost["Service"] = {
      id: LOCAL_DEVICE_HOST_ID,
      label: "Pool",
      summary: Effect.succeed({
        id: LOCAL_DEVICE_HOST_ID,
        kind: "local",
        label: "Pool",
        platforms: [{ platform: "ios", available: true }],
        hubInstalled: true,
        agentDeviceInstalled: true,
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
      ensureReady: () => Effect.succeed(ready),
      ensureAgentReady: () => Effect.succeed(ready),
      current: Effect.succeed(ready),
      stopAgent: Effect.void,
      stop: Effect.void,
    };
    const released: string[] = [];
    const service = yield* DeviceService.makeWithHosts(
      new Map([[host.id, host]]),
      undefined,
      () => Effect.succeed("agent-device.json"),
      undefined,
      {
        bind: ({ session }) => Effect.succeed(session),
        prune: () => Effect.void,
        release: (launcher) => Effect.sync(() => void released.push(launcher)),
      },
    ).pipe(Effect.provide(NodeCrypto.layer));
    const threads = [ThreadId.make("pool-a"), ThreadId.make("pool-b")];
    for (const threadId of threads) {
      yield* service.open({ threadId, deviceId, platform: "ios" });
      const target = { threadId, hostId: LOCAL_DEVICE_HOST_ID, deviceId };
      const agent = yield* service.agentTarget(target);
      expect(agent.session).toBe("lease-session");
      yield* service.agentLauncher({ ...target, targetArgs: agent.args });
    }
    yield* service.close({ threadId: threads[0]! });
    expect(released).toEqual([]);
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
    ),
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
      let listed: "booted" | "off" | "missing" = "booted";
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
      const run = () => Effect.succeed({ code: 0, stdout: "", stderr: "" });
      const ready: DeviceHost.DeviceHostReady = {
        nodePath: process.execPath,
        hub: { origin: "http://device.test" },
        devices: makeDeviceHubOperations({
          hostId: LOCAL_DEVICE_HOST_ID,
          origin: "http://device.test",
          http,
          run,
          androidAvailable: Effect.succeed(true),
        }),
        helpers: { serveSimAxSettings: null, serveSimCli: null },
        run,
      };
      const host: DeviceHost.DeviceHost["Service"] = {
        id: LOCAL_DEVICE_HOST_ID,
        label: "This machine",
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
      const service = yield* DeviceService.makeWithHosts(new Map([[host.id, host]])).pipe(
        Effect.provide(NodeCrypto.layer),
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
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);
it.effect.each([LOCAL_DEVICE_HOST_ID, "ssh-fixture"])(
  "retains hub inventory on %s when AVD enumeration fails and recovers on retry",
  (hostId) =>
    Effect.gen(function* () {
      let enumeration = { code: 1, stdout: "private stdout", stderr: "private stderr" };
      const run = () => Effect.sync(() => enumeration);
      const hubDevices = [
        { id: "iphone", name: "iPhone", platform: "ios", physical: false },
        { id: "phone", name: "Pixel", platform: "android", physical: true },
        { id: "emulator-5554", name: "Running_AVD", platform: "android", physical: false },
      ].map((device) => ({ ...device, booted: true, version: "test" }));
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ simulators: hubDevices.slice(0, 1), emulators: hubDevices.slice(1) }),
          ),
        ),
      );
      const ready: DeviceHost.DeviceHostReady = {
        nodePath: process.execPath,
        hub: { origin: "http://device.test" },
        devices: makeDeviceHubOperations({
          hostId,
          origin: "http://device.test",
          http,
          run,
          androidAvailable: Effect.succeed(true),
        }),
        helpers: { serveSimAxSettings: null, serveSimCli: null },
        run,
      };
      const host: DeviceHost.DeviceHost["Service"] = {
        id: hostId,
        label: "Test device host",
        summary: Effect.succeed({
          id: hostId,
          kind: hostId === LOCAL_DEVICE_HOST_ID ? "local" : "ssh",
          label: "Test device host",
          platforms: [{ platform: "android", available: true }],
          hubInstalled: true,
          agentDeviceInstalled: false,
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () => Effect.succeed(ready),
        ensureAgentReady: () => Effect.die("Agent access is not used in this test"),
        current: Effect.succeed(ready),
        stop: Effect.void,
        stopAgent: Effect.void,
      };
      const service = yield* DeviceService.makeWithHosts(new Map([[hostId, host]])).pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(HttpClient.HttpClient, http),
      );

      const incomplete = yield* service.list;
      expect(incomplete.devices).toEqual(hubDevices.map((device) => ({ ...device, hostId })));
      expect(incomplete.hostStatuses[hostId]).toEqual({
        status: "ready",
        androidDiscoveryIncomplete: true,
        detail:
          "Could not list Android virtual devices (emulator -list-avds, exit code 1). Discovered devices remain available.",
      });
      if (hostId === LOCAL_DEVICE_HOST_ID) {
        expect(incomplete.hostStatusDetail).toBe(incomplete.hostStatuses[hostId]?.detail);
      }

      enumeration = { code: 0, stdout: "Running_AVD\r\nStopped_AVD\nStopped_AVD\n", stderr: "" };
      const recovered = yield* service.retryHost(hostId);
      expect(recovered.devices).toEqual([
        ...hubDevices.map((device) => ({ ...device, hostId })),
        {
          hostId,
          id: "Stopped_AVD",
          name: "Stopped_AVD",
          platform: "android",
          version: "Android",
          booted: false,
          physical: false,
        },
      ]);
      expect(recovered.hostStatuses[hostId]).toEqual({ status: "ready" });
      if (hostId === LOCAL_DEVICE_HOST_ID) expect(recovered.hostStatusDetail).toBeUndefined();
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
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
it.effect("failed read-only discovery preserves lifecycle status and installed inventory", () =>
  Effect.gen(function* () {
    const { service, starts } = yield* fixture(Effect.void, undefined, false, undefined, true);
    const state = yield* service.inspect;
    expect(state.supportsToolInspection).toBe(true);
    expect(state.hostStatus).toBe("disabled");
    expect(state.hosts[0]?.hubInstalled).toBe(true);
    expect(state.hosts[0]?.toolInspectionError).toContain("Reconnect the host");
    expect(starts).toEqual([]);
  }).pipe(Effect.scoped),
);
it.effect(
  "manual updates install only the selected tool without enabling access or starting helpers",
  () =>
    Effect.gen(function* () {
      const installed: string[] = [];
      const { service, starts, agentStarts, requests } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        (tool) =>
          Effect.sync(() => {
            installed.push(tool);
          }),
      );
      const before = yield* service.state;
      const state = yield* service.updateTool("agent");
      expect(installed).toEqual(["agent"]);
      expect(state.supportsToolUpdate).toBe(true);
      expect(state.hostStatus).toBe(before.hostStatus);
      expect(state.agentAccessEnabled).toBe(before.agentAccessEnabled);
      expect(state.revision).toBeGreaterThan(before.revision);
      expect(starts).toEqual([]);
      expect(agentStarts).toEqual([]);
      expect(requests).toEqual([]);
      yield* service.updateTool("hub");
      expect(installed).toEqual(["agent", "hub"]);
    }).pipe(Effect.scoped),
);
it.effect("failed manual installation leaves lifecycle state unchanged and can be retried", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const { service, starts, agentStarts } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      () =>
        Effect.suspend(() =>
          ++attempts === 1
            ? Effect.fail(
                new DeviceOperationError({
                  operation: "update device tool",
                  reason: "command_failed",
                  cause: new Error("offline"),
                }),
              )
            : Effect.void,
        ),
    );
    const before = yield* service.state;
    const result = yield* service.updateTool("agent").pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(yield* service.state).toEqual(before);
    yield* service.updateTool("agent");
    expect(attempts).toBe(2);
    expect(starts).toEqual([]);
    expect(agentStarts).toEqual([]);
  }).pipe(Effect.scoped),
);

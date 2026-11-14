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













import { fixture, layerSecretResolver } from "./DeviceService-fixtures.testkit.ts";
it.effect("reconciles SSH host settings without publishing no-op changes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-reconcile-" });
    const settings = yield* ServerSettings.ServerSettingsService;
    // Each change is acknowledged after reconciliation consumed it, so no-ops are observable.
    const changes = yield* Queue.unbounded<{ value: Settings; done: Deferred.Deferred<void> }>();
    const removedFiles: string[] = [];
    const localHost: DeviceHost.DeviceHost["Service"] = {
      id: LOCAL_DEVICE_HOST_ID,
      label: "This machine",
      summary: Effect.succeed({
        id: LOCAL_DEVICE_HOST_ID,
        label: "Local",
        kind: "local",
        platforms: [],
        hubInstalled: false,
        agentDeviceInstalled: false,
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: false }),
      current: Effect.succeed(null),
      ensureReady: () => Effect.die("Unexpected device launch"),
      ensureAgentReady: () => Effect.die("Unexpected agent launch"),
      stop: Effect.void,
      stopAgent: Effect.void,
    };
    const service = yield* DeviceService.make.pipe(
      Effect.provideService(DeviceHost.DeviceHost, localHost),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        ...settings,
        subscribeChanges: Effect.succeed(
          Stream.fromQueue(changes).pipe(
            Stream.flatMap(({ value, done }) =>
              Stream.make(value).pipe(
                Stream.concat(
                  Stream.fromEffect(Deferred.succeed(done, undefined)).pipe(Stream.drain),
                ),
              ),
            ),
          ),
        ),
      }),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          remove: (file) => Effect.sync(() => void removedFiles.push(file)),
        }),
      ),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.die("Unexpected helper launch"),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected HTTP request")),
      ),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              stdout: Stream.make(new TextEncoder().encode("hostname 192.0.2.1\nport 22\n")),
              stderr: Stream.empty,
              all: Stream.empty,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          ),
        ),
      ),
      Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
    );
    const update = Effect.fnUntraced(function* (deviceHosts: ReadonlyArray<SshDeviceHostConfig>) {
      const value = yield* settings.updateSettings({ deviceHosts: [...deviceHosts] });
      const done = yield* Deferred.make<void>();
      yield* Queue.offer(changes, { value, done });
      yield* Deferred.await(done);
      return yield* service.state;
    });

    const initial = yield* service.state;
    expect(yield* update([])).toEqual(initial);

    const host: SshDeviceHostConfig = {
      kind: "ssh",
      id: "remote",
      label: "Remote",
      target: "remote-fixture",
    };
    const added = yield* update([host]);
    expect(added.hosts.map((entry) => entry.id)).toEqual([LOCAL_DEVICE_HOST_ID, host.id]);
    expect(yield* update([{ ...host }])).toEqual(added);

    yield* service.setHostStatus(host.id, { status: "failed", detail: "stale" });
    const removed = yield* update([]);
    expect(removed.hosts.map((entry) => entry.id)).toEqual([LOCAL_DEVICE_HOST_ID]);
    expect(removed.hostStatuses[host.id]).toBeUndefined();
    expect(removedFiles).toHaveLength(1);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest(),
        layerSecretResolver,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  ),
);
it.effect("a failed tool update reports npm's exit code but not its output", () =>
  Effect.gen(function* () {
    const host: DeviceHost.DeviceHost["Service"] = {
      id: LOCAL_DEVICE_HOST_ID,
      label: "This machine",
      summary: Effect.succeed({
        id: LOCAL_DEVICE_HOST_ID,
        kind: "local",
        label: "Test server",
        platforms: [],
        hubInstalled: false,
        agentDeviceInstalled: false,
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: false }),
      ensureReady: () => Effect.die("Updating a tool does not start the hub"),
      ensureAgentReady: () => Effect.die("Updating a tool does not start the agent"),
      current: Effect.succeed(null),
      stopAgent: Effect.void,
      stop: Effect.void,
    };
    const npmFailure = {
      code: ChildProcessSpawner.ExitCode(243),
      stdout: "",
      stderr: "npm error EACCES https://private:credential@registry.example.test/expo-device-hub",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    };
    const service = yield* DeviceService.make.pipe(
      Effect.provideService(DeviceHost.DeviceHost, host),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.succeed(npmFailure),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Updating a tool makes no hub requests")),
      ),
    );

    const error = yield* service.updateTool("hub").pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "DeviceOperationError",
      reason: "command_failed",
      exitCode: 243,
    });
    expect(error.message).toBe(
      "Device update device tool failed: The device command failed (exit code 243).",
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({ enableDeviceSupport: true }),
        layerSecretResolver,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-device-update-" }),
        NodeCrypto.layer,
        NetService.layer,
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.scoped,
  ),
);
describe("agent session release on close", () => {
  const openClaim = (
    service: DeviceService.DeviceService["Service"],
    threadId: ThreadId,
    deviceId = "Pixel_API_35",
  ) => service.open({ threadId, deviceId, platform: "android" });

  it.effect("releases only the caller's session, keeps the device booted, and is idempotent", () =>
    Effect.gen(function* () {
      const { service, closedSessions, requests } = yield* fixture();
      yield* service.configure({ enabled: true, agentAccessEnabled: true });
      const threadId = ThreadId.make("closing");
      const other = ThreadId.make("other");
      const session = yield* openClaim(service, threadId);
      yield* openClaim(service, other, session.deviceId);
      yield* service.close({ threadId, deviceId: session.deviceId });
      yield* service.close({ threadId, deviceId: session.deviceId });
      const name = yield* agentDeviceSession(threadId, session.hostId, session.deviceId).pipe(
        Effect.provide(NodeCrypto.layer),
      );
      expect(closedSessions).toEqual([
        {
          jsonrpc: "2.0",
          id: name,
          method: "agent_device.command",
          params: { command: "close", session: name, positionals: [], flags: {} },
        },
      ]);
      const state = yield* service.state;
      expect(state.sessions.map((entry) => entry.threadId)).toEqual([other]);
      expect(state.devices.find((entry) => entry.id === session.deviceId)?.booted).toBe(true);
      expect(requests.some((url) => url.endsWith("/shutdown"))).toBe(false);
    }),
  );

  it.effect.each(["reject", "http_error", "malformed"] as const)(
    "retains retryable state on %s",
    (failure) =>
      Effect.gen(function* () {
        let fail = true;
        const { service, requests, closedSessions } = yield* fixture(
          Effect.void,
          undefined,
          false,
          undefined,
          false,
          undefined,
          { onClose: Effect.sync(() => (fail ? failure : "ok")) },
        );
        yield* service.configure({ enabled: true, agentAccessEnabled: true });
        const threadId = ThreadId.make("retry");
        yield* openClaim(service, threadId);
        const exit = yield* Effect.exit(service.close({ threadId, shutdown: true }));
        expect(Exit.isFailure(exit)).toBe(true);
        expect((yield* service.state).sessions).toHaveLength(1);
        expect(requests.some((url) => url.endsWith("/shutdown"))).toBe(false);
        fail = false;
        yield* service.close({ threadId });
        expect((yield* service.state).sessions).toHaveLength(0);
        expect(closedSessions).toHaveLength(2);
      }),
  );

  it.effect.each([false, true])("accepts a missing agent session, shutdown=%s", (shutdown) =>
    Effect.gen(function* () {
      const { service, requests } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        undefined,
        { onClose: Effect.succeed("missing") },
      );
      yield* service.configure({ enabled: true, agentAccessEnabled: true });
      const threadId = ThreadId.make("no-claim");
      yield* openClaim(service, threadId);
      yield* service.close({ threadId, shutdown });
      expect((yield* service.state).sessions).toHaveLength(0);
      expect(requests.some((url) => url.endsWith("/shutdown"))).toBe(shutdown);
    }),
  );

  it.effect("retries shutdown after the first attempt already released the agent session", () =>
    Effect.gen(function* () {
      let released = false;
      const { service, connection } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        undefined,
        {
          onClose: Effect.sync(() => {
            const result = released ? "missing" : "ok";
            released = true;
            return result;
          }),
        },
      );
      yield* service.configure({ enabled: true, agentAccessEnabled: true });
      const threadId = ThreadId.make("retry-shutdown");
      yield* openClaim(service, threadId);
      connection.failShutdown = true;
      expect(Exit.isFailure(yield* Effect.exit(service.close({ threadId, shutdown: true })))).toBe(
        true,
      );
      expect((yield* service.state).sessions).toHaveLength(1);
      connection.failShutdown = false;
      yield* service.close({ threadId, shutdown: true });
      expect((yield* service.state).sessions).toHaveLength(0);
    }),
  );

  it.effect("releases the post-boot agentTarget session for a cold Android AVD", () =>
    Effect.gen(function* () {
      const { service, closedSessions } = yield* fixture();
      yield* service.configure({ enabled: true, agentAccessEnabled: true });
      const threadId = ThreadId.make("cold-avd");
      const before = yield* service.agentTarget({
        threadId,
        hostId: "local",
        deviceId: "Pixel_API_35",
      });
      const session = yield* openClaim(service, threadId);
      const after = yield* service.agentTarget({
        threadId,
        hostId: session.hostId,
        deviceId: session.deviceId,
      });
      expect(session.deviceId).toBe("emulator-5554");
      expect(after.args[3]).not.toBe(before.args[3]);
      yield* service.close({ threadId });
      expect(closedSessions).toEqual([
        expect.objectContaining({ params: expect.objectContaining({ session: after.args[3] }) }),
      ]);
    }),
  );

  it.effect("retains an SSH record during reconnect and releases it on retry", () =>
    Effect.gen(function* () {
      const { service, connection, closedSessions, agentStarts } = yield* fixture();
      connection.kind = "ssh";
      yield* service.configure({ enabled: true, agentAccessEnabled: true });
      const threadId = ThreadId.make("ssh-reconnect");
      yield* openClaim(service, threadId);
      const starts = agentStarts.length;
      connection.online = false;
      expect(Exit.isFailure(yield* Effect.exit(service.close({ threadId })))).toBe(true);
      expect((yield* service.state).sessions).toHaveLength(1);
      expect(closedSessions).toHaveLength(0);
      expect(agentStarts).toHaveLength(starts);
      connection.online = true;
      yield* service.close({ threadId });
      expect((yield* service.state).sessions).toHaveLength(0);
      expect(closedSessions).toHaveLength(1);
    }),
  );
  it.effect("releases peer claims before a close shuts down", () =>
    Effect.gen(function* () {
      const { service, closedSessions } = yield* fixture();
      yield* service.configure({ enabled: true, agentAccessEnabled: true });
      const threadId = ThreadId.make("shutting-down");
      const other = ThreadId.make("peer");
      const session = yield* openClaim(service, threadId);
      yield* openClaim(service, other, session.deviceId);
      yield* service.close({ threadId, shutdown: true });
      expect((yield* service.state).sessions).toHaveLength(0);
      yield* service.close({ threadId: other });
      expect((yield* service.state).sessions).toHaveLength(0);
      const names = yield* Effect.forEach([threadId, other], (thread) =>
        agentDeviceSession(thread, session.hostId, session.deviceId),
      ).pipe(Effect.provide(NodeCrypto.layer));
      expect(
        closedSessions.map((body) => (body as { params: { session: string } }).params.session),
      ).toEqual(names);
    }),
  );

  it.effect("publishes a reopened session only after the old claim is released and removed", () =>
    Effect.gen(function* () {
      const entered = yield* Queue.unbounded<void>();
      const releasing = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const { service } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        undefined,
        {
          onClose: Effect.gen(function* () {
            yield* Deferred.succeed(releasing, undefined);
            yield* Deferred.await(finish);
            return "ok" as const;
          }),
          onPlatformAvailability: Queue.offer(entered, undefined),
        },
      );
      yield* service.configure({ enabled: true, agentAccessEnabled: true });
      const threadId = ThreadId.make("reopen");
      const session = yield* openClaim(service, threadId);
      yield* Queue.take(entered);
      const publications = yield* service.subscribe;
      const closing = yield* service.close({ threadId }).pipe(Effect.forkChild);
      yield* Deferred.await(releasing);
      const opening = yield* openClaim(service, threadId, session.deviceId).pipe(Effect.forkChild);
      yield* Queue.take(entered);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(closing);
      const reopened = yield* Fiber.join(opening);
      const published = (yield* PubSub.takeAll(publications))
        .map(({ sessions }) =>
          sessions.includes(session) ? "old" : sessions.includes(reopened) ? "reopened" : "none",
        )
        .filter((label, index, labels) => label !== labels[index - 1]);
      expect(published).toEqual(["none", "reopened"]);
    }).pipe(Effect.scoped),
  );
});
describe("locating a device id across hosts", () => {
  const threadId = ThreadId.make("thread-locate");
  const thisMachine = { id: LOCAL_DEVICE_HOST_ID, label: "This machine" };
  const macMini = { id: "mac-mini", label: "Mac Mini" };
  const listingHost = (
    host: { readonly id: string; readonly label: string },
    ids: ReadonlyArray<string>,
  ): DeviceHost.DeviceHost["Service"] => {
    const devices = ids.map((id) => ({
      id,
      name: id,
      platform: id.startsWith("Pixel") ? ("android" as const) : ("ios" as const),
      version: "test",
      booted: true,
      physical: false,
    }));
    const ready: DeviceHost.DeviceHostReady = {
      nodePath: process.execPath,
      hub: { origin: "http://device.test" },
      devices: {
        list: Effect.succeed({ devices, detail: undefined }),
        boot: (device) => Effect.succeed(device.id),
        attach: () => Effect.void,
        shutdown: () => Effect.void,
        screenshot: () => Effect.succeed(new Uint8Array()),
      },
      // Opening an emulator checks its host for ffmpeg's H.264 encoder.
      run: () => Effect.succeed({ code: 0, stdout: " V....D libx264", stderr: "" }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
    };
    return {
      ...host,
      summary: Effect.succeed({
        ...host,
        kind: host.id === LOCAL_DEVICE_HOST_ID ? "local" : "ssh",
        platforms: [
          { platform: "ios", available: true },
          { platform: "android", available: true },
        ],
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
  };
  // An Android AVD name, like Pixel_10 here, can exist on two hosts.
  const withTwoHosts = <A, E>(
    test: (service: DeviceService.DeviceService["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const service = yield* DeviceService.makeWithHosts(
        new Map([
          [thisMachine.id, listingHost(thisMachine, ["Pixel_10"])],
          [macMini.id, listingHost(macMini, ["MAC-UDID", "Pixel_10"])],
        ]),
      ).pipe(Effect.provide(NodeCrypto.layer));
      yield* service.list;
      return yield* test(service);
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped);
  const open = (
    service: DeviceService.DeviceService["Service"],
    hostId: string,
    deviceId: string,
    thread = threadId,
  ) =>
    service.open({
      threadId: thread,
      hostId,
      deviceId: DeviceId.make(deviceId),
      platform: deviceId.startsWith("Pixel") ? "android" : "ios",
    });

  it.effect("finds a device id that exists only on another host", () =>
    withTwoHosts((service) =>
      Effect.gen(function* () {
        const located = yield* service.locateDevice({ deviceId: DeviceId.make("MAC-UDID") });
        expect(Option.getOrUndefined(located)).toMatchObject({
          hostId: "mac-mini",
          id: "MAC-UDID",
        });
      }),
    ),
  );

  it.effect("refuses a device id that exists on two hosts and names both", () =>
    withTwoHosts((service) =>
      Effect.gen(function* () {
        const error = yield* service
          .locateDevice({ deviceId: DeviceId.make("Pixel_10") })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "DeviceHostAmbiguousError", deviceId: "Pixel_10" });
        expect(error.hosts).toHaveLength(2);
        expect(error.hosts).toEqual(expect.arrayContaining([thisMachine, macMini]));
      }),
    ),
  );

  it.effect("keeps an explicit hostId and says which host has the device", () =>
    withTwoHosts((service) =>
      Effect.gen(function* () {
        const error = yield* service
          .locateDevice({ deviceId: DeviceId.make("MAC-UDID"), hostId: LOCAL_DEVICE_HOST_ID })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "DeviceOnOtherHostError",
          deviceId: "MAC-UDID",
          host: thisMachine,
          hosts: [macMini],
        });
        const onMac = yield* service.locateDevice({
          deviceId: DeviceId.make("Pixel_10"),
          hostId: "mac-mini",
        });
        expect(Option.getOrUndefined(onMac)).toMatchObject({ hostId: "mac-mini", id: "Pixel_10" });
      }),
    ),
  );

  it.effect("finds nothing for a device id that no host lists", () =>
    withTwoHosts((service) =>
      Effect.gen(function* () {
        const deviceId = DeviceId.make("Pixel_9");
        expect(yield* service.locateDevice({ deviceId })).toEqual(Option.none());
        expect(yield* service.locateDevice({ deviceId, hostId: "mac-mini" })).toEqual(
          Option.none(),
        );
        expect(yield* service.locateDevice({ deviceId, hostId: "unknown-host" })).toEqual(
          Option.none(),
        );
      }),
    ),
  );

  it.effect("finds an open device by id on whichever host it is on", () =>
    withTwoHosts((service) =>
      Effect.gen(function* () {
        yield* open(service, "mac-mini", "MAC-UDID");
        const deviceId = DeviceId.make("MAC-UDID");
        expect(
          Option.getOrUndefined(yield* service.locateSession({ threadId, deviceId })),
        ).toMatchObject({ threadId, hostId: "mac-mini", deviceId });
        const error = yield* service
          .locateSession({ threadId, deviceId, hostId: LOCAL_DEVICE_HOST_ID })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "DeviceOnOtherHostError",
          host: thisMachine,
          hosts: [macMini],
        });
      }),
    ),
  );

  it.effect("refuses an id open on two hosts unless the hostId picks one", () =>
    withTwoHosts((service) =>
      Effect.gen(function* () {
        yield* open(service, LOCAL_DEVICE_HOST_ID, "Pixel_10");
        yield* open(service, "mac-mini", "Pixel_10");
        const deviceId = DeviceId.make("Pixel_10");
        const error = yield* service.locateSession({ threadId, deviceId }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "DeviceHostAmbiguousError", deviceId });
        expect(error.hosts).toEqual(expect.arrayContaining([thisMachine, macMini]));
        const onMac = yield* service.locateSession({ threadId, deviceId, hostId: "mac-mini" });
        expect(Option.getOrUndefined(onMac)).toMatchObject({ hostId: "mac-mini", deviceId });
      }),
    ),
  );

  it.effect("finds no session for a device this thread has not opened", () =>
    withTwoHosts((service) =>
      Effect.gen(function* () {
        const deviceId = DeviceId.make("MAC-UDID");
        expect(yield* service.locateSession({ threadId, deviceId })).toEqual(Option.none());
        yield* open(service, "mac-mini", "MAC-UDID", ThreadId.make("thread-other"));
        expect(yield* service.locateSession({ threadId, deviceId })).toEqual(Option.none());
        expect(
          yield* service.locateSession({ threadId, deviceId, hostId: LOCAL_DEVICE_HOST_ID }),
        ).toEqual(Option.none());
      }),
    ),
  );
});

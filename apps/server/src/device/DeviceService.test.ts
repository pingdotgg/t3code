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

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeBootError = Schema.decodeUnknownSync(Schema.fromJsonString(DeviceBootError));
const encodeBootError = Schema.encodeSync(Schema.fromJsonString(DeviceBootError));

it.effect.each([400, 500])(
  "distinguishes screenshot HTTP rejection (%s) from transport failure",
  (status) =>
    Effect.gen(function* () {
      const operations = makeDeviceHubOperations({
        hostId: LOCAL_DEVICE_HOST_ID,
        origin: "http://device.test",
        http: HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("private hub output", { status })),
          ),
        ),
        run: () => Effect.die("Screenshot does not run a command"),
        androidAvailable: Effect.succeed(false),
      });
      const result = yield* operations
        .screenshot({
          id: "phone",
          name: "Phone",
          version: "iOS 26.3",
          platform: "ios",
          booted: true,
          physical: false,
        })
        .pipe(Effect.result);
      expect(result).toMatchObject({
        failure: { _tag: "DeviceOperationError", reason: "hub_rejected" },
      });
    }),
);

const fixture = Effect.fn("fixture")(function* (
  onBoot: Effect.Effect<void> = Effect.void,
  bootError?: string | { error?: string; errors?: Array<{ message: string; error?: string }> },
  failListAfterShutdown = false,
  runtimeFailure?:
    | NodeRuntimeUnavailableError
    | DeviceHost.DeviceHostError
    | DeviceHost.AgentDeviceStartError,
  inspectError = false,
  installTool?: Parameters<typeof DeviceService.makeWithHosts>[3],
  options: {
    readonly endsDevices?: boolean;
    readonly routesStreams?: boolean;
    readonly onClose?: Effect.Effect<"ok" | "missing" | "reject" | "http_error" | "malformed">;
    readonly onPlatformAvailability?: Effect.Effect<void>;
  } = {},
) {
  const settings = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
  const starts: string[] = [];
  const agentStarts: string[] = [];
  const agentStops: string[] = [];
  const requests: string[] = [];
  const closedSessions: unknown[] = [];
  const devices: Array<Omit<DeviceSummary, "hostId">> = [];
  const discoveryErrors = yield* Ref.make<Array<{ message: string; error?: string }>>([]);
  const androidAvailable = yield* Ref.make(true);
  const encoderResult = yield* Ref.make({ code: 0, stdout: " V....D libx264", stderr: "" });
  let booted = false;
  let shutDown = false;
  const connection = { online: true, kind: "local" as "local" | "ssh", failShutdown: false };
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push(request.url);
      if (request.url === "http://agent.test/rpc") {
        if (request.body._tag !== "Uint8Array") throw new Error("Missing close body");
        const body = decodeJson(new TextDecoder().decode(request.body.body));
        closedSessions.push(body);
        expect(request.headers.authorization).toBe("Bearer test");
        const outcome = yield* options.onClose ?? Effect.succeed("ok");
        return HttpClientResponse.fromWeb(
          request,
          outcome === "missing"
            ? Response.json(
                {
                  error: {
                    code: -32000,
                    message: "No active session",
                    data: { code: "SESSION_NOT_FOUND" },
                  },
                },
                { status: 404 },
              )
            : outcome === "http_error"
              ? new Response("Offline", { status: 503 })
              : outcome === "malformed"
                ? new Response("not JSON")
                : Response.json(
                    outcome === "ok"
                      ? { result: { ok: true } }
                      : { error: { code: -32000, message: "offline" } },
                  ),
        );
      }
      if (request.url.includes("/api/screenshot")) {
        return HttpClientResponse.fromWeb(request, new Response(new Uint8Array([137, 80, 78, 71])));
      }
      if (request.url.endsWith("/shutdown")) {
        if (connection.failShutdown)
          return HttpClientResponse.fromWeb(request, Response.json({ ok: false }));
        shutDown = true;
        booted = false;
        return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
      }
      if (shutDown && failListAfterShutdown) {
        return HttpClientResponse.fromWeb(request, new Response("Discovery busy", { status: 503 }));
      }
      if (request.url.endsWith("/boot")) {
        yield* onBoot;
        booted = true;
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            bootError
              ? { ok: false, ...(typeof bootError === "string" ? { error: bootError } : bootError) }
              : { ok: true, serial: "emulator-5554" },
          ),
        );
      }
      if (request.url.endsWith("/grid/api/start")) {
        return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          errors: yield* Ref.get(discoveryErrors),
          simulators: devices.filter((device) => device.platform === "ios"),
          emulators: [
            ...devices.filter((device) => device.platform === "android"),
            ...(booted
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
              : []),
          ],
        }),
      );
    }),
  );
  const run = (command: string) =>
    command === "emulator"
      ? Effect.succeed({ code: 0, stdout: "Pixel_API_35\n", stderr: "" })
      : Ref.get(encoderResult);
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    devices: {
      ...makeDeviceHubOperations({
        hostId: LOCAL_DEVICE_HOST_ID,
        origin: "http://device.test",
        http,
        run,
        androidAvailable: Ref.get(androidAvailable),
      }),
      ...(options.endsDevices ? { endsDevices: true } : {}),
    },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run,
    ...(options.routesStreams ? { upstream: () => Effect.succeed(null) } : {}),
  };
  const host: DeviceHost.DeviceHost["Service"] = {
    ...(inspectError
      ? {
          inspect: Effect.fail(
            new DeviceHost.DeviceHostError({
              hostId: LOCAL_DEVICE_HOST_ID,
              step: "probe",
              cause: new Error("offline"),
            }),
          ),
        }
      : {}),
    id: LOCAL_DEVICE_HOST_ID,
    label: "This machine",
    summary: Effect.sync(() => ({
      id: LOCAL_DEVICE_HOST_ID,
      kind: connection.kind,
      label: "Test server",
      platforms: [
        { platform: "android", available: true },
        { platform: "ios", available: true },
      ],
      hubInstalled: true,
      agentDeviceInstalled: false,
    })),
    platformAvailability: (platform) =>
      (options.onPlatformAvailability ?? Effect.void).pipe(
        Effect.as({ platform, available: true }),
      ),
    ensureReady: (onPhase) =>
      Effect.gen(function* () {
        if (runtimeFailure && runtimeFailure._tag !== "AgentDeviceStartError")
          return yield* runtimeFailure;
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
    current: Effect.sync(() =>
      connection.online
        ? {
            ...ready,
            ...(agentStarts.length > agentStops.length
              ? {
                  releaseAgentSession: releaseAgentDeviceSession(http, {
                    baseUrl: "http://agent.test",
                    token: "test",
                  }),
                }
              : {}),
          }
        : null,
    ),
    stopAgent: Effect.sync(() => {
      agentStops.push("stop");
    }),
    stop: Effect.sync(() => {
      starts.push("stop");
    }),
  };
  const service = yield* DeviceService.makeWithHosts(
    new Map([[host.id, host]]),
    undefined,
    () => Effect.succeed("/host.json"),
    installTool,
  ).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(DeviceHost.DeviceHost, host),
    Effect.provideService(
      ServerSettings.ServerSettingsService,
      ServerSettings.ServerSettingsService.of({
        updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
        withSettingsSnapshot: (use) => Effect.flatMap(Ref.get(settings), use),
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
  );
  // The host ending a device on its own, as EAS does at a session's limits.
  const endDevice = () => {
    booted = false;
  };
  return {
    service,
    starts,
    agentStarts,
    agentStops,
    requests,
    settings,
    closedSessions,
    connection,
    devices,
    encoderResult,
    discoveryErrors,
    androidAvailable,
    endDevice,
  };
});

describe("device setup consent", () => {
  it.effect("exposes daemon startup diagnostics through agent readiness and host status", () =>
    Effect.gen(function* () {
      const startupError = new DeviceHost.AgentDeviceStartError({
        hostId: LOCAL_DEVICE_HOST_ID,
        stateDir: "/test/device/agent-device",
        exitCode: 1,
        reason: "daemon_lock_not_directory",
        cause: { stdout: "private startup diagnostics", code: 1 },
      });
      const { service, settings } = yield* fixture(Effect.void, undefined, false, startupError);
      yield* Ref.update(settings, (current) => ({
        ...current,
        enableDeviceSupport: true,
        enableAgentDeviceAccess: true,
      }));
      const error = yield* service.agentReadinessIfSupported().pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DeviceHostUnavailableError",
        reason: startupError.message,
        cause: startupError,
      });
      expect(error.message).toContain("daemon.lock is not a directory");
      expect(error.message).not.toContain("private startup diagnostics");
      expect((yield* service.state).hostStatuses[LOCAL_DEVICE_HOST_ID]).toEqual({
        status: "failed",
        detail: startupError.message,
      });
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

  it.effect("blocks only emulator video until ffmpeg is usable, then allows retry", () =>
    Effect.gen(function* () {
      const { service, requests, devices, encoderResult } = yield* fixture();
      devices.push(
        {
          id: DeviceId.make("physical-android"),
          name: "Pixel",
          platform: "android",
          version: "Android 15",
          booted: true,
          physical: true,
        },
        {
          id: DeviceId.make("ios-simulator"),
          name: "iPhone",
          platform: "ios",
          version: "iOS 18",
          booted: true,
          physical: false,
        },
      );
      yield* Ref.set(encoderResult, { code: 127, stdout: "", stderr: "spawn ffmpeg ENOENT" });
      const state = yield* service.configure({ enabled: true });
      expect(state.devices.map((device) => device.id)).toEqual([
        "ios-simulator",
        "physical-android",
        "Pixel_API_35",
      ]);
      const threadId = ThreadId.make("emulator-video-readiness");
      const physical = yield* service.open({
        threadId,
        deviceId: "physical-android",
        platform: "android",
      });
      const ios = yield* service.open({ threadId, deviceId: "ios-simulator", platform: "ios" });
      expect(physical.deviceId).toBe("physical-android");
      expect(ios.deviceId).toBe("ios-simulator");

      const openEmulator = service.open({
        threadId,
        deviceId: "Pixel_API_35",
        platform: "android",
      });
      const missing = yield* openEmulator.pipe(Effect.flip);
      expect(missing.message).toMatch(/ffmpeg/i);
      expect(missing.message).toMatch(/emulator/i);
      expect(requests.filter((url) => url.endsWith("/boot"))).toEqual([]);
      expect((yield* service.state).sessions).toEqual([physical, ios]);
      expect((yield* service.state).bootingDevices ?? []).toEqual([]);

      yield* Ref.set(encoderResult, { code: 1, stdout: "", stderr: "cannot execute ffmpeg" });
      expect((yield* openEmulator.pipe(Effect.flip)).message).toMatch(/ffmpeg/i);
      yield* Ref.set(encoderResult, {
        code: 0,
        stdout: " V....D libx264rgb   libx264 H.264 / AVC RGB (codec h264)",
        stderr: "",
      });
      expect((yield* openEmulator.pipe(Effect.flip)).message).toMatch(/libx264/i);
      expect(requests.filter((url) => url.endsWith("/boot"))).toEqual([]);
      expect((yield* service.state).sessions).toEqual([physical, ios]);

      devices.push({
        id: DeviceId.make("emulator-5556"),
        name: "Already_booted",
        platform: "android",
        version: "Android 15",
        booted: true,
        physical: false,
      });
      expect(
        (yield* service
          .open({ threadId, deviceId: "emulator-5556", platform: "android" })
          .pipe(Effect.flip)).message,
      ).toMatch(/libx264/i);

      yield* Ref.set(encoderResult, { code: 0, stdout: " V....D libx264", stderr: "" });
      const emulator = yield* openEmulator;
      expect(emulator.deviceId).toBe("emulator-5554");
      expect(requests.filter((url) => url.endsWith("/boot"))).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("opens emulators on hosts that route their own streams without ffmpeg", () =>
    Effect.gen(function* () {
      const { service, requests, encoderResult } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        undefined,
        { routesStreams: true },
      );
      yield* Ref.set(encoderResult, { code: 127, stdout: "", stderr: "host commands unavailable" });
      yield* service.configure({ enabled: true });
      const session = yield* service.open({
        threadId: ThreadId.make("pool-emulator"),
        deviceId: "Pixel_API_35",
        platform: "android",
      });
      expect(session.deviceId).toBe("emulator-5554");
      expect(requests.filter((url) => url.endsWith("/boot"))).toHaveLength(1);
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

it.effect.each([
  { case: "drops it on a host that ends devices itself", endsDevices: true, kept: 0 },
  {
    case: "keeps it on a host that can miss a device for one listing",
    endsDevices: false,
    kept: 1,
  },
])("when a host stops listing a session's device, $case", ({ endsDevices, kept }) =>
  Effect.gen(function* () {
    const { service, endDevice } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      undefined,
      { endsDevices },
    );
    yield* service.configure({ enabled: true });
    const threadId = ThreadId.make("ended-by-host");
    yield* service.open({ threadId, deviceId: "Pixel_API_35", platform: "android" });
    expect((yield* service.state).sessions.map((session) => session.deviceId)).toEqual([
      "emulator-5554",
    ]);
    endDevice();
    yield* service.list;
    expect((yield* service.state).sessions).toHaveLength(kept);
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

const missingPlistMessage =
  "[apple-utils] Failed to read CoreSimulator plist at /Users/test/Library/Developer/CoreSimulator/Devices/deleted-simulator/device.plist:";

it.effect("keeps other discovery warnings and clears them when only a deleted plist remains", () =>
  Effect.gen(function* () {
    const { service, discoveryErrors } = yield* fixture();
    const missing = {
      message: missingPlistMessage,
      error: "Error: ENOENT: no such file or directory",
    };
    yield* Ref.set(discoveryErrors, [missing, { message: "Android discovery failed." }]);
    const initial = yield* service.configure({ enabled: true });
    expect(initial.hostStatusDetail).toBe("Android discovery failed.");
    yield* Ref.set(discoveryErrors, [missing]);
    const refreshed = yield* service.list;
    expect(refreshed.hostStatusDetail).toBeUndefined();
    expect(refreshed.hostStatuses.local?.detail).toBeUndefined();
  }).pipe(Effect.scoped),
);

it.effect("hides Android discovery failures when the host has no Android SDK", () =>
  Effect.gen(function* () {
    const { service, discoveryErrors, androidAvailable } = yield* fixture();
    const avdmanagerFailure = { message: "[android-utils] Failed to run `avdmanager list avd`:" };
    yield* Ref.set(discoveryErrors, [avdmanagerFailure, { message: "iOS discovery failed." }]);
    yield* Ref.set(androidAvailable, false);
    const withoutSdk = yield* service.configure({ enabled: true });
    expect(withoutSdk.hostStatusDetail).toBe("iOS discovery failed.");
    yield* Ref.set(androidAvailable, true);
    const withSdk = yield* service.list;
    expect(withSdk.hostStatusDetail).toBe(`${avdmanagerFailure.message}\niOS discovery failed.`);
  }).pipe(Effect.scoped),
);

// The hub reports `error` as a util.inspect of Node's exec error.
const simctlMessage = "[apple-utils] Failed to run `xcrun simctl list devices --json`:";
const simctlCause =
  "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=60): Unable to connect to CoreSimulatorService [xcrun shim fail mode]";
const simctlError = `Error: Command failed: xcrun simctl list devices --json
${simctlCause}

    at genericNodeError (node:internal/errors:986:15)
    at wrappedFn (node:internal/errors:540:14)
    at ChildProcess.exithandler (node:child_process:417:12)
    at ChildProcess._handle.onexit (node:internal/child_process:335:5) {
  code: 1,
  killed: false,
  signal: null,
  cmd: 'xcrun simctl list devices --json',
  stdout: '',
  stderr: '${simctlCause}\\n'
}`;
const avdmanager = "/Users/test/Library/Android/sdk/cmdline-tools/latest/bin/avdmanager";
const avdmanagerError = `Error: spawn ${avdmanager} ENOENT
    at ChildProcess._handle.onexit (node:internal/child_process:316:19)
    at onErrorNT (node:internal/child_process:524:16) {
  errno: -2,
  code: 'ENOENT',
  syscall: 'spawn ${avdmanager}',
  path: '${avdmanager}',
  spawnargs: [ 'list', 'avd' ],
  cmd: '${avdmanager} list avd',
  stdout: '',
  stderr: ''
}`;

it.effect("keeps the cause from the hub's error in discovery warnings, without the stack", () =>
  Effect.gen(function* () {
    const { service, discoveryErrors } = yield* fixture();
    yield* Ref.set(discoveryErrors, [
      { message: simctlMessage, error: simctlError },
      { message: "[android-utils] Failed to run `avdmanager list avd`:", error: avdmanagerError },
    ]);
    const state = yield* service.configure({ enabled: true });
    expect(state.hostStatusDetail).toBe(
      [
        `${simctlMessage} Error: Command failed: xcrun simctl list devices --json ${simctlCause}`,
        `[android-utils] Failed to run \`avdmanager list avd\`: Error: spawn ${avdmanager} ENOENT`,
      ].join("\n"),
    );
    expect(state.hostStatusDetail).not.toContain("    at ");
    expect(state.hostStatusDetail).not.toContain("stderr:");
  }).pipe(Effect.scoped),
);

it.effect.each([
  {
    diagnostic: "Insufficient disk space at /private/user/path",
    reason: "disk_space",
    message: "not enough free disk space",
  },
  {
    diagnostic: "Timed out spawning /private/user/command",
    reason: "timeout",
    message: "did not become ready in time",
  },
  {
    diagnostic:
      "The emulator process exited with code 1.\nTry manually: emulator -avd Pixel_API_35",
    reason: "launch_failed",
    message: "could not start",
  },
] as const)("normalizes boot failure: $reason", ({ diagnostic, message }) =>
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
    expect(error.message).toContain(diagnostic);
    expect((yield* service.state).bootingDevices).toEqual([]);
  }).pipe(Effect.scoped),
);

// regression: #22012 report Android emulator boot failures
it.effect("includes nested hub boot diagnostics and bounds them to 2,000 characters", () =>
  Effect.gen(function* () {
    const diagnostic = "Error: emulator binary missing\n" + "diagnostic output\n".repeat(200);
    const { service } = yield* fixture(Effect.void, {
      error: "Failed to spawn emulator",
      errors: [{ message: "Failed to launch emulator binary", error: diagnostic }],
    });
    yield* service.configure({ enabled: true });
    const error = yield* service
      .open({
        threadId: ThreadId.make("nested-boot-failure"),
        deviceId: "Pixel_API_35",
        platform: "android",
      })
      .pipe(Effect.flip);
    expect(error._tag).toBe("DeviceBootError");
    if (error._tag !== "DeviceBootError") return;
    const expected = `Failed to spawn emulator\n\nFailed to launch emulator binary\n\n${diagnostic}`;
    expect(error.diagnostics).toBe(`${expected.slice(0, 1_999)}…`);
    expect(error.diagnostics).toHaveLength(2_000);
    expect(error.message).toContain(error.diagnostics);
    const roundTrip = decodeBootError(encodeBootError(error));
    expect(roundTrip.message).toBe(error.message);
    expect((yield* service.state).bootingDevices).toEqual([]);
  }).pipe(Effect.scoped),
);

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
    Effect.provide(Layer.mergeAll(ServerSettings.layerTest(), NodeServices.layer)),
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

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

import {
  DeviceBootError,
  type DeviceHostId,
  DeviceOperationError,
  type DevicePlatform,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { DeviceHostReady, DeviceOperations, HostDevice } from "./DeviceHost.ts";

const BOOT_TIMEOUT = Duration.minutes(3);
const SCREENSHOT_TIMEOUT = Duration.seconds(20);

const HubDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  booted: Schema.Boolean,
  physical: Schema.Boolean,
});
const HubDeviceList = Schema.Struct({
  simulators: Schema.Array(HubDevice),
  emulators: Schema.Array(HubDevice),
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ message: Schema.String, error: Schema.optional(Schema.String) })),
  ),
});
const HubActionResult = Schema.Struct({
  ok: Schema.Boolean,
  id: Schema.optional(Schema.String),
  serial: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ message: Schema.String, error: Schema.optional(Schema.String) })),
  ),
});

const vendorPrefix = (platform: DevicePlatform) =>
  platform === "ios" ? "/vendor/serve-sim" : "/vendor/serve-emu";

/** Device operations for a host that runs expo-device-hub at `origin`. */
export const makeDeviceHubOperations = (options: {
  readonly hostId: DeviceHostId;
  readonly origin: string;
  readonly http: HttpClient.HttpClient;
  readonly run: DeviceHostReady["run"];
  /** Whether to list AVDs, which the hub does not report until they boot. */
  readonly androidAvailable: Effect.Effect<boolean>;
}): DeviceOperations => {
  const { hostId, origin, run } = options;
  const httpClient = options.http.pipe(HttpClient.withScope);

  const hubJson = <A, I>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I>,
    operation: string,
    timeout: Duration.Input = Duration.seconds(15),
  ) =>
    httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.mapError(
        (cause) =>
          new DeviceOperationError({
            operation,
            reason: "request_failed",
            cause,
          }),
      ),
    );

  const postJson = (path: string, body: Record<string, string>, operation: string) =>
    HttpClientRequest.post(`${origin}${path}`).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.mapError(
        (cause) => new DeviceOperationError({ operation, reason: "invalid_payload", cause }),
      ),
    );

  // Booting alone does not attach a serve-sim helper; the grid start does both
  // and is idempotent for a booted simulator.
  const attachIosStream = (udid: string, operation: string) =>
    postJson(`${vendorPrefix("ios")}/grid/api/start`, { udid }, operation).pipe(
      Effect.flatMap((request) => hubJson(request, HubActionResult, "attach stream", BOOT_TIMEOUT)),
    );

  const list: DeviceOperations["list"] = Effect.gen(function* () {
    const hubList = yield* hubJson(
      HttpClientRequest.get(`${origin}/api/devices`),
      HubDeviceList,
      "list",
    );
    const devices: Array<HostDevice> = [...hubList.simulators, ...hubList.emulators];
    const androidAvailable = yield* options.androidAvailable;
    const warnings = hubList.errors?.filter(
      (error) =>
        // The host summary already explains a missing Android SDK; the hub's failed probes are noise.
        !(!androidAvailable && error.message.startsWith("[android-utils] ")) &&
        // CoreSimulator can retain deleted devices; their optional usage timestamps are absent.
        !(
          error.message.startsWith("[apple-utils] Failed to read CoreSimulator plist at ") &&
          /\/CoreSimulator\/Devices\/[^/]+\/device\.plist:$/.test(error.message) &&
          /(?:^Error:\s*ENOENT:|\bcode:\s*['"]ENOENT['"])/.test(error.error ?? "")
        ),
    );
    const details = warnings?.map((error) => error.message) ?? [];
    let androidDiscoveryIncomplete = false;
    if (androidAvailable) {
      const avds = yield* run("emulator", ["-list-avds"]);
      // Discovered devices stay listed; the AVDs that could not be listed are a warning.
      if (avds.code !== 0) {
        androidDiscoveryIncomplete = true;
        details.push(
          `Could not list Android virtual devices (emulator -list-avds, exit code ${avds.code}). Discovered devices remain available.`,
        );
      }
      for (const name of (avds.code === 0 ? avds.stdout : "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)) {
        if (!devices.some((device) => device.platform === "android" && device.name === name)) {
          devices.push({
            id: name,
            name,
            platform: "android",
            version: "Android",
            booted: false,
            physical: false,
          });
        }
      }
    }
    return {
      devices,
      detail: details.join("\n") || undefined,
      androidDiscoveryIncomplete,
    };
  }).pipe(Effect.withSpan("DeviceHubOperations.list"));

  const boot: DeviceOperations["boot"] = Effect.fn("DeviceHubOperations.boot")(function* (device) {
    const result = yield* postJson(
      "/api/devices/boot",
      { platform: device.platform, id: device.id, name: device.name },
      "boot",
    ).pipe(Effect.flatMap((request) => hubJson(request, HubActionResult, "boot", BOOT_TIMEOUT)));
    if (!result.ok) {
      // Keep the hub's launch command and nested failure available to agents for recovery.
      const diagnostics = [
        result.error,
        ...(result.errors ?? []).flatMap((error) => [error.message, error.error]),
      ]
        .filter((text) => text?.trim())
        .join("\n\n");
      return yield* new DeviceBootError({
        hostId,
        deviceId: device.id,
        reason: /insufficient.*(?:disk|space)|not enough.*(?:disk|space)|no space left/i.test(
          diagnostics,
        )
          ? "disk_space"
          : /timed? out|timeout/i.test(diagnostics)
            ? "timeout"
            : "launch_failed",
        ...(diagnostics
          ? {
              diagnostics:
                diagnostics.length > 2_000 ? `${diagnostics.slice(0, 1_999)}…` : diagnostics,
            }
          : {}),
        cause: result,
      });
    }
    if (device.platform === "ios") yield* attachIosStream(device.id, "boot");
    return result.serial ?? result.id ?? device.id;
  });

  const attach: DeviceOperations["attach"] = (device) =>
    device.platform === "ios"
      ? attachIosStream(device.id, "open").pipe(Effect.asVoid)
      : Effect.void;

  const shutdown: DeviceOperations["shutdown"] = Effect.fn("DeviceHubOperations.shutdown")(
    function* (device) {
      const postShutdown = (path: string, body: Record<string, string>) =>
        postJson(path, body, "shutdown").pipe(
          Effect.flatMap((request) => hubJson(request, HubActionResult, "shutdown")),
          Effect.flatMap((result) =>
            result.ok
              ? Effect.void
              : Effect.fail(
                  new DeviceOperationError({
                    operation: "shutdown",
                    reason: "hub_rejected",
                    cause: result,
                  }),
                ),
          ),
        );
      // serve-sim's shutdown closes its in-process capture session before it
      // runs `simctl shutdown`; the hub's generic shutdown can leave that
      // session cached across a reboot. serve-sim runs simctl bare, though, so
      // a simulator that is already off fails there.
      yield* device.platform === "ios"
        ? postShutdown(`${vendorPrefix("ios")}/grid/api/shutdown`, { udid: device.id }).pipe(
            Effect.catch((cause) =>
              list.pipe(
                Effect.flatMap(({ devices }) =>
                  devices.find((candidate) => candidate.id === device.id)?.booted === false
                    ? Effect.logInfo("iOS simulator was already shut down", { deviceId: device.id })
                    : Effect.fail(cause),
                ),
              ),
            ),
          )
        : postShutdown("/api/devices/shutdown", { platform: device.platform, id: device.id });
    },
  );

  const screenshot: DeviceOperations["screenshot"] = (device) =>
    httpClient
      .execute(
        HttpClientRequest.post(
          `${origin}${vendorPrefix(device.platform)}/api/screenshot?device=${encodeURIComponent(device.id)}`,
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.scoped,
        Effect.timeout(SCREENSHOT_TIMEOUT),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({
              operation: "screenshot",
              reason: "request_failed",
              cause,
            }),
        ),
        Effect.withSpan("DeviceHubOperations.screenshot"),
      );

  return { list, boot, attach, shutdown, screenshot };
};

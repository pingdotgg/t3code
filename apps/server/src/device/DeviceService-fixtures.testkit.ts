// @effect-diagnostics preferSchemaOverJson:off
// shared fixtures for DeviceService (never imports the test file)
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
export const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const fixture = Effect.fn("fixture")(function* (
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


export const layerSecretResolver = Layer.succeed(SecretResolver.SecretResolver, {
  read: (references) => Effect.succeed(references.map(() => undefined)),
  invalidate: () => Effect.void,
});

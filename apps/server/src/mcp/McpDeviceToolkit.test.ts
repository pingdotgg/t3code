import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  DeviceHostUnavailableError,
  DeviceOperationError,
  type DeviceSession,
  DeviceId,
  ProjectId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment-device-test");
const threadId = ThreadId.make("thread-device-test");
const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId,
  requestNamespace: "provider-session-device-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-device-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const device = {
  hostId: "local",
  id: "UDID-1",
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};
const state = {
  hosts: [
    {
      id: "local",
      kind: "local" as const,
      label: "This machine",
      platforms: [
        { platform: "ios" as const, available: true },
        { platform: "android" as const, available: false, reason: "No SDK" },
      ],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready" as const,
  hostStatuses: { local: { status: "ready" as const } },
  devices: [device],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};
const png = new Uint8Array(24);
new DataView(png.buffer).setUint32(0, 0x89504e47);
new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
new DataView(png.buffer).setUint32(12, 0x49484452);
new DataView(png.buffer).setUint32(16, 1206);
new DataView(png.buffer).setUint32(20, 2622);

const agentReady: DeviceService.DeviceAgentReadiness = {
  hostId: "local",
  nodePath: "/node",
  hub: { origin: "http://localhost:4100" },
  run: () => Effect.die("not used"),
  helpers: { serveSimAxSettings: null, serveSimCli: null },
  agentDevice: {
    baseUrl: "http://localhost:4101",
    token: "test-agent-token",
    entryPath: "/cli",
  },
};

const layerDeviceServiceMock = Layer.mock(DeviceService.DeviceService)({
  state: Effect.succeed(state),
  list: Effect.succeed(state),
  completeOpen: () => Effect.void,
  open: (input) =>
    Effect.succeed({
      threadId: input.threadId,
      hostId: "local",
      deviceId: input.deviceId,
      platform: input.platform,
      openedAt: "2026-09-08T00:00:00.000Z",
    }),
  // UDID-1 is open in the test thread; UDID-2 exists but belongs to another thread.
  sessionsForThread: (id) =>
    Effect.succeed(
      id === threadId
        ? [
            {
              threadId,
              hostId: "local",
              deviceId: DeviceId.make("UDID-1"),
              platform: "ios" as const,
              openedAt: "2026-09-08T00:00:00.000Z",
            },
          ]
        : [],
    ),
  screenshot: () => Effect.succeed({ device, png }),
  close: () => Effect.void,
  agentCli: Effect.succeed("/cli"),
  testHost: () => Effect.die("not used"),
  agentReadinessIfSupported: () => Effect.succeed(agentReady),
  agentTarget: () => Effect.succeed(["--config", "/host.json", "--session", "thread-device"]),
});

const projectId = ProjectId.make("project:mcp-test");
const project: ProjectStore.ProjectRow = {
  projectId,
  title: "Device test project",
  workspaceRoot: "/test/project",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};
const allowedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  enableDeviceSupport: true,
  enableAgentDeviceAccess: true,
};
const layerAccess = Layer.mergeAll(
  McpToolAccessTestkit.liveThreadProjectionsLayer,
  Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.some(project)) }),
  Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.succeed(allowedSettings),
  }),
);

const layerTest = McpHttpServer.layerDeviceToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(layerDeviceServiceMock),
  Layer.provide(layerAccess),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-toolkit-test-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("registers the device tools and returns the screenshot as image content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name).toSorted();
      expect(names).toEqual(["device_close", "device_list", "device_open", "device_screenshot"]);

      const callWith = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities));

      const opened = yield* server
        .callTool({ name: "device_open", arguments: { platform: "ios" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(opened.isError).toBe(false);
      const openedContent = opened.structuredContent as { quickStart: string };
      expect(openedContent.quickStart).toContain("--udid UDID-1");

      const shot = yield* server
        .callTool({ name: "device_screenshot", arguments: { deviceId: "UDID-1" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(shot.isError).toBe(false);
      expect(shot.content.map((entry) => entry.type)).toEqual(["text", "image"]);
      expect(shot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 1206, height: 2622 },
      });

      const foreign = yield* server
        .callTool({ name: "device_screenshot", arguments: { deviceId: "UDID-2" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(foreign.isError).toBe(true);
      expect(foreign.content.map((entry) => entry.type)).toEqual(["text"]);

      const denied = yield* server
        .callTool({ name: "device_list", arguments: {} })
        .pipe(callWith(["preview"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(denied.isError).toBe(true);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  {
    name: "stopped Android AVD",
    selected: "Pixel_API_35",
    opened: "emulator-5554",
    platform: "android" as const,
    refreshed: true,
  },
  {
    name: "Android AVD with a stale device list",
    selected: "Pixel_API_35",
    opened: "emulator-5554",
    platform: "android" as const,
    refreshed: false,
  },
  {
    name: "running Android emulator",
    selected: "emulator-5554",
    opened: "emulator-5554",
    platform: "android" as const,
    refreshed: true,
  },
  {
    name: "iOS simulator",
    selected: "UDID-1",
    opened: "UDID-1",
    platform: "ios" as const,
    refreshed: true,
  },
])(
  "issues the device credential for the opened $name",
  ({ selected, opened, platform, refreshed }) => {
    const selectedDevice = { ...device, id: selected, platform, booted: selected === opened };
    const openedDevice = { ...selectedDevice, id: opened, booted: true };
    const operations: string[] = [];
    const scopedArgs = ["--config", "/host.json", "--session", "opened-device-session"];
    const layerOpening = Layer.mock(DeviceService.DeviceService)({
      list: Effect.succeed({ ...state, devices: [selectedDevice] }),
      state: Effect.succeed({ ...state, devices: [refreshed ? openedDevice : selectedDevice] }),
      agentReadinessIfSupported: (hostId, enabled) =>
        Effect.sync(() => {
          expect(hostId).toBe("local");
          expect(enabled).toBe(true);
          operations.push("ready");
          return agentReady;
        }),
      open: (input) =>
        Effect.sync(() => {
          expect(operations).toEqual(["ready"]);
          expect(input.deviceId).toBe(selected);
          operations.push("open");
          return {
            threadId: input.threadId,
            hostId: "local",
            deviceId: DeviceId.make(opened),
            platform,
            openedAt: "2026-09-08T00:00:00.000Z",
          };
        }),
      agentTarget: (input) =>
        Effect.sync(() => {
          expect(operations).toEqual(["ready", "open"]);
          expect(input).toEqual({
            openedSession: {
              threadId,
              hostId: "local",
              deviceId: opened,
              platform,
              openedAt: "2026-09-08T00:00:00.000Z",
            },
            agentAccessEnabled: true,
          });
          operations.push("credential");
          return scopedArgs;
        }),
      agentCli: Effect.succeed("/cli"),
      abortOpen: () => Effect.die("A successful open must retain its session"),
      completeOpen: () => Effect.void,
    });
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: "device_open", arguments: { platform } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(false);
      expect(operations).toEqual(["ready", "open", "credential"]);
      const selector = platform === "android" ? "--serial" : "--udid";
      expect(result.structuredContent).toMatchObject({
        device: { id: opened, platform },
        agentDevice: { targetArgs: ["--platform", platform, selector, opened, ...scopedArgs] },
        quickStart: expect.stringContaining(`${selector} ${opened}`),
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        McpHttpServer.layerDeviceToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(layerOpening),
          Layer.provide(layerAccess),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-open-test-" }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  },
);

it.effect("does not boot or issue a credential when agent readiness is unsupported", () => {
  const layerUnsupported = Layer.mock(DeviceService.DeviceService)({
    list: Effect.succeed(state),
    agentReadinessIfSupported: () => Effect.succeed(null),
    open: () => Effect.die("Must not boot without agent readiness"),
    agentTarget: () => Effect.die("Must not issue a credential without agent readiness"),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "device_open", arguments: { platform: "ios" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Agent device access requires"),
        }),
      ]),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.layerDeviceToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(layerUnsupported),
        Layer.provide(layerAccess),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

it.effect("rejects unavailable agent access before booting or opening a device", () => {
  const layerUnavailable = Layer.mock(DeviceService.DeviceService)({
    list: Effect.succeed(state),
    agentReadinessIfSupported: () =>
      Effect.fail(
        new DeviceHostUnavailableError({ hostId: "local", reason: "Agent access is disabled." }),
      ),
    open: () => Effect.die("Must not boot or register a device when agent access fails"),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "device_open", arguments: { platform: "ios" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Agent access is disabled."),
        }),
      ]),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.layerDeviceToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(layerUnavailable),
        Layer.provide(layerAccess),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

it.effect.each([
  { name: "environment revocation", globalAccess: true, projectAccess: undefined },
  { name: "project revocation with the environment off", globalAccess: false, projectAccess: true },
])("rejects the same device credential after $name", ({ globalAccess, projectAccess }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const availableProject = yield* Ref.make(Option.some(project));
      const settings = yield* Ref.make({
        ...DEFAULT_SERVER_SETTINGS,
        enableDeviceSupport: true,
        enableAgentDeviceAccess: globalAccess,
        projectSettingsOverrides: {
          [projectId]:
            projectAccess === undefined ? {} : { enableAgentDeviceAccess: projectAccess },
        },
      });
      const operations: string[] = [];
      const observedService = Layer.mock(DeviceService.DeviceService)({
        state: Effect.succeed(state),
        list: Effect.sync(() => {
          operations.push("list");
          return state;
        }),
        agentReadinessIfSupported: () => Effect.succeed(agentReady),
        agentTarget: () =>
          Effect.sync(() => {
            operations.push("agent helper");
            return ["--config", "/host.json", "--session", "thread-device"];
          }),
        open: (input) =>
          Effect.sync(() => {
            operations.push("open");
            return {
              threadId: input.threadId,
              hostId: "local",
              deviceId: input.deviceId,
              platform: input.platform,
              openedAt: "2026-09-08T00:00:00.000Z",
            };
          }),
        agentCli: Effect.succeed("/cli"),
        completeOpen: () => Effect.void,
        sessionsForThread: () =>
          Effect.sync(() => {
            operations.push("device sessions");
            return [];
          }),
        close: () =>
          Effect.sync(() => {
            operations.push("close");
          }),
      });
      const dependencies = Layer.mergeAll(
        observedService,
        McpToolAccessTestkit.liveThreadsLayer,
        McpToolAccessTestkit.liveThreadProjectionsLayer,
        Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Ref.get(availableProject) }),
        Layer.mock(ServerSettings.ServerSettingsService)({ getSettings: Ref.get(settings) }),
      );
      const server = yield* McpServer.McpServer.pipe(
        Effect.provide(
          McpHttpServer.layerDeviceToolkit.pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(dependencies),
          ),
        ),
      );
      const credential = invocation(["device"]);
      const call = (name: string, args = {}) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, credential),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      expect((yield* call("device_open", { platform: "ios" })).isError).toBe(false);
      expect(operations).toEqual(["list", "open", "agent helper"]);
      yield* Ref.set(availableProject, Option.none());
      expect((yield* call("device_open", { platform: "ios" })).isError).toBe(true);
      expect(operations).toEqual(["list", "open", "agent helper"]);
      yield* Ref.set(
        availableProject,
        Option.some({ ...project, deletedAt: "2026-10-01T00:00:00.000Z" }),
      );
      expect((yield* call("device_open", { platform: "ios" })).isError).toBe(true);
      expect(operations).toEqual(["list", "open", "agent helper"]);
      yield* Ref.set(availableProject, Option.some(project));
      yield* Ref.update(settings, (current) => ({
        ...current,
        enableAgentDeviceAccess: false,
        projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: false } },
      }));
      for (const name of ["device_open", "device_list", "device_screenshot", "device_close"]) {
        const denied = yield* call(name, name === "device_open" ? { platform: "ios" } : {});
        expect(denied.isError).toBe(true);
        expect(denied.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining(
                name === "device_screenshot"
                  ? "Device screenshot failed."
                  : "Agent device access is turned off",
              ),
            }),
          ]),
        );
      }
      expect(operations).toEqual(["list", "open", "agent helper"]);
    }),
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-revoke-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect.each([
  { stage: "denied", cleanupFails: false },
  { stage: "config", cleanupFails: false },
  { stage: "cli", cleanupFails: false },
  { stage: "shim", cleanupFails: false },
  { stage: "denied", cleanupFails: true },
] as const)(
  "rolls back the exact opened session after $stage failure (cleanup failure: $cleanupFails)",
  ({ stage, cleanupFails }) => {
    const openedSession = {
      threadId,
      hostId: "local",
      deviceId: DeviceId.make("UDID-1"),
      platform: "ios" as const,
      openedAt: "2026-09-08T00:00:00.000Z",
    };
    const aborted: DeviceSession[] = [];
    const failure =
      stage === "config"
        ? new DeviceOperationError({
            operation: "configure agent",
            reason: "settings_failed",
            cause: new Error("synthetic config write failure"),
          })
        : new DeviceHostUnavailableError({
            hostId: "local",
            reason:
              stage === "cli"
                ? "Agent CLI is unavailable."
                : "Agent access was revoked during boot.",
          });
    let issued = false;
    const failingDevices = Layer.mock(DeviceService.DeviceService)({
      list: Effect.succeed(state),
      state: Effect.succeed(state),
      agentReadinessIfSupported: () => Effect.succeed(agentReady),
      open: () => Effect.succeed(openedSession),
      agentTarget: (input) =>
        Effect.gen(function* () {
          expect(input.openedSession).toBe(openedSession);
          if (stage === "denied" || stage === "config") return yield* failure;
          issued = true;
          return ["--config", "/host.json", "--session", "opened-device-session"];
        }),
      agentCli: stage === "cli" ? Effect.fail(failure) : Effect.succeed("/cli"),
      abortOpen: (session) =>
        Effect.gen(function* () {
          aborted.push(session);
          if (cleanupFails)
            return yield* new DeviceHostUnavailableError({
              hostId: "local",
              reason: "Synthetic cleanup failure.",
            });
        }),
      close: () => Effect.die("Rollback must use exact session identity, not stable device IDs"),
    });
    const failingShim = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const writeFileString: FileSystem.FileSystem["writeFileString"] = (
          file,
          content,
          options,
        ) =>
          stage === "shim" && file.endsWith("agent-device-launcher.mjs")
            ? Effect.fail(
                new PlatformError.PlatformError(
                  new PlatformError.SystemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: file,
                  }),
                ),
              )
            : fs.writeFileString(file, content, options);
        return { ...fs, writeFileString };
      }),
    ).pipe(Layer.provide(NodeServices.layer));
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: "device_open", arguments: { platform: "ios" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining(
              stage === "shim" ? "Could not prepare the agent-device launcher." : failure.message,
            ),
          }),
        ]),
      );
      expect(aborted).toHaveLength(1);
      expect(aborted[0]).toBe(openedSession);
      expect(issued).toBe(stage === "cli" || stage === "shim");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        McpHttpServer.layerDeviceToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(failingDevices),
          Layer.provide(layerAccess),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-device-rollback-test-" }),
          ),
          Layer.provide(failingShim),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  },
);

it.effect("rolls back the opened session when post-open credential issuance is interrupted", () =>
  Effect.gen(function* () {
    const issuing = yield* Deferred.make<void>();
    const openedSession = {
      threadId,
      hostId: "local",
      deviceId: DeviceId.make("UDID-1"),
      platform: "ios" as const,
      openedAt: "2026-09-08T00:00:00.000Z",
    };
    const aborted: DeviceSession[] = [];
    const delayedDevices = Layer.mock(DeviceService.DeviceService)({
      list: Effect.succeed(state),
      agentReadinessIfSupported: () => Effect.succeed(agentReady),
      open: () => Effect.succeed(openedSession),
      agentTarget: () => Deferred.succeed(issuing, undefined).pipe(Effect.andThen(Effect.never)),
      abortOpen: (session) =>
        Effect.sync(() => {
          aborted.push(session);
        }),
      close: () => Effect.die("Rollback must not close a device by stable IDs"),
    });
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const request = yield* server
        .callTool({ name: "device_open", arguments: { platform: "ios" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.forkChild,
        );
      yield* Deferred.await(issuing);
      yield* Fiber.interrupt(request);
      expect(aborted).toHaveLength(1);
      expect(aborted[0]).toBe(openedSession);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        McpHttpServer.layerDeviceToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(delayedDevices),
          Layer.provide(layerAccess),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  }),
);

it.effect.each([
  { name: "environment access", globalAccess: true, projectAccess: undefined },
  { name: "project access", globalAccess: false, projectAccess: true },
])(
  "does not boot when $name is revoked during agent readiness",
  ({ globalAccess, projectAccess }) =>
    Effect.gen(function* () {
      const readinessStarted = yield* Deferred.make<void>();
      const resumeReadiness = yield* Deferred.make<void>();
      const settings = yield* Ref.make({
        ...allowedSettings,
        enableAgentDeviceAccess: globalAccess,
        projectSettingsOverrides:
          projectAccess === undefined
            ? {}
            : { [projectId]: { enableAgentDeviceAccess: projectAccess } },
      });
      const sessions = yield* Ref.make<ReadonlyArray<DeviceSession>>([]);
      let bootCalls = 0;
      const devices = Layer.mock(DeviceService.DeviceService)({
        list: Effect.succeed(state),
        state: Ref.get(sessions).pipe(Effect.map((sessions) => ({ ...state, sessions }))),
        agentReadinessIfSupported: () =>
          Deferred.succeed(readinessStarted, undefined).pipe(
            Effect.andThen(Deferred.await(resumeReadiness)),
            Effect.as(agentReady),
          ),
        open: (input) =>
          Effect.gen(function* () {
            bootCalls++;
            const session = {
              threadId: input.threadId,
              hostId: "local",
              deviceId: input.deviceId,
              platform: input.platform,
              openedAt: "2026-09-08T00:00:00.000Z",
            };
            yield* Ref.update(sessions, (current) => [...current, session]);
            return session;
          }),
        agentTarget: () =>
          Effect.die("Revoked access must be rejected before boot or credential issuance"),
        abortOpen: () => Effect.die("No session should be opened for revoked access"),
      });
      const access = Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        McpToolAccessTestkit.liveThreadProjectionsLayer,
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({ getSettings: Ref.get(settings) }),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const opening = yield* server
          .callTool({ name: "device_open", arguments: { platform: "ios" } })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              invocation(["device"]),
            ),
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.forkChild,
          );
        yield* Deferred.await(readinessStarted);
        yield* Ref.update(settings, (current) => ({
          ...current,
          enableAgentDeviceAccess: false,
          projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: false } },
        }));
        yield* Deferred.succeed(resumeReadiness, undefined);
        expect((yield* Fiber.join(opening)).isError).toBe(true);
        expect(bootCalls).toBe(0);
        expect(yield* Ref.get(sessions)).toEqual([]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          McpHttpServer.layerDeviceToolkit.pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(devices),
            Layer.provide(access),
          ),
        ),
      );
    }),
);

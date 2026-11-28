import { describe, expect, it } from "@effect/vitest";
import {
  CALM_HOST_PRESSURE,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ServerSettingsError,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:settings");
const threadId = ThreadId.make("thread:settings");

const layerEnvironment = (overrides: {
  readonly getThreadShell: ThreadManagement.ThreadManagementService["Service"]["getThreadShell"];
  readonly updateSettings?: Settings.ServerSettingsService["Service"]["updateSettings"];
}) =>
  Layer.mergeAll(
    ThreadCommandExecutor.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId,
      requestNamespace: "provider:preferences",
      thread: {
        threadId,
        providerSessionId: "provider:preferences",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 0,
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: overrides.getThreadShell,
    }),
    Layer.mock(Environment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId,
        label: "Test",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0",
        capabilities: { repositoryIdentity: false },
      }),
    }),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      ...(overrides.updateSettings === undefined
        ? {}
        : { updateSettings: overrides.updateSettings }),
    }),
    Layer.mock(HostResources.HostResources)({
      read: Effect.succeed({
        sampledAt: 0,
        cpuUtilization: 0.934,
        cpuCount: 16,
        availableMemoryBytes: 3.26e9,
        totalMemoryBytes: 64e9,
        diskFreeBytes: 812e9,
        diskTotalBytes: 2e12,
      }),
      readPressure: Effect.succeed({ ...CALM_HOST_PRESSURE, memory: "severe", cpu: "elevated" }),
    }),
  );

const layerCaller = (
  shell: Effect.Effect<OrchestrationV2ThreadShell>,
  settings: Layer.Layer<Settings.ServerSettingsService, ServerSettingsError>,
) =>
  McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:settings",
          thread: {
            threadId,
            providerSessionId: "provider:settings",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({ getThreadShell: () => shell }),
        Layer.mock(Environment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        // Settings tools never read the machine; `t3_environment_read` does.
        Layer.mock(HostResources.HostResources)({}),
        settings,
      ),
    ),
  );

const call = (name: keyof typeof EnvironmentToolkit.tools, params: object) =>
  Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit;
    const results = yield* toolkit
      .handle(name, params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)?.result as unknown;
  });

describe("t3_settings_read", () => {
  it.effect("redacts secrets, leaves out legacy mirrors, and marks locked keys", () =>
    Effect.gen(function* () {
      const listed = (yield* call("t3_settings_read", {})) as {
        settings: ReadonlyArray<{ key: string; access: string; locked?: boolean }>;
      };
      const keys = listed.settings.map((entry) => entry.key);
      expect(keys).toContain("cloudSpeechCredentials");
      expect(keys).not.toContain("compactIdleThreads");
      expect(keys).not.toContain("projectAutoPullOverrides");
      expect(listed.settings.find((entry) => entry.key === "keepAwakeWhileAgentsWork")).toEqual({
        key: "keepAwakeWhileAgentsWork",
        access: "write",
        changed: false,
        locked: true,
      });

      const read = yield* call("t3_settings_read", {
        keys: ["cloudSpeechCredentials", "branchNamePrefix"],
      });
      expect(JSON.stringify(read)).not.toContain("sk-must-not-escape");
      expect(read).toMatchObject({
        settings: [
          { key: "cloudSpeechCredentials", access: "user", changed: true },
          { key: "branchNamePrefix", access: "write", changed: true, value: "jl" },
        ],
        schema: { properties: { branchNamePrefix: { type: "string" } } },
      });
      expect(read).not.toHaveProperty("schema.properties.cloudSpeechCredentials");
      expect((read as { settings: ReadonlyArray<object> }).settings[0]).not.toHaveProperty("value");
    }).pipe(
      Effect.provide(
        layerCaller(
          Effect.succeed(liveThreadShell(threadId)),
          Settings.ServerSettingsService.layerTest(
            {
              branchNamePrefix: "jl",
              cloudSpeechCredentials: { openai: "sk-must-not-escape" },
            },
            { organization: "Example Corp", lockedSettings: ["keepAwakeWhileAgentsWork"] },
          ),
        ),
      ),
    ),
  );
});

it.effect("reads an untouched server as unchanged, and a null setting as null", () =>
  Effect.gen(function* () {
    const listed = (yield* call("t3_settings_read", {})) as {
      settings: ReadonlyArray<{ key: string; changed: boolean }>;
    };
    expect(listed.settings.filter((entry) => entry.changed).map((entry) => entry.key)).toEqual([]);
    expect(yield* call("t3_settings_read", { keys: ["defaultThreadEnvMode"] })).toMatchObject({
      settings: [{ key: "defaultThreadEnvMode", value: null }],
    });
    const repeated = (yield* call("t3_settings_read", {
      keys: ["branchNamePrefix", "branchNamePrefix"],
    })) as { settings: ReadonlyArray<object> };
    expect(repeated.settings).toHaveLength(1);
  }).pipe(
    Effect.provide(
      layerCaller(
        Effect.succeed(liveThreadShell(threadId)),
        Settings.ServerSettingsService.layerTest(),
      ),
    ),
  ),
);

it.effect("keeps agent feedback out of the settings agents read and write", () =>
  Effect.gen(function* () {
    const listed = (yield* call("t3_settings_read", {})) as {
      settings: ReadonlyArray<{ key: string }>;
    };
    expect(listed.settings.map((entry) => entry.key)).not.toContain("agentFeedback");
    expect(yield* call("t3_settings_read", { keys: ["agentFeedback"] })).toMatchObject({
      code: "invalid_request",
    });
    expect(
      yield* call("t3_settings_update", { settings: { agentFeedback: { mode: "auto" } } }),
    ).toMatchObject({ code: "invalid_request" });
  }).pipe(
    Effect.provide(
      layerCaller(
        Effect.succeed(liveThreadShell(threadId)),
        Settings.ServerSettingsService.layerTest({ agentFeedback: { mode: "auto" } }),
      ),
    ),
  ),
);

it.effect("t3_environment_read tells agents how loaded the machine is", () =>
  Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit;
    const result = yield* toolkit
      .handle("t3_environment_read", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toMatchObject({
      machine: {
        pressure: { memory: "severe", cpu: "elevated", io: "none", disk: "none" },
        cpuCount: 16,
        cpuUsedPercent: 93,
        memoryAvailableGb: 3.3,
        memoryTotalGb: 64,
        diskFreeGb: 812,
      },
    });
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
        Layer.provideMerge(
          layerEnvironment({ getThreadShell: () => Effect.succeed(liveThreadShell(threadId)) }),
        ),
      ),
    ),
  ),
);

describe("t3_settings_update", () => {
  const recordingSettings = (
    patches: Ref.Ref<ReadonlyArray<unknown>>,
    updateSettings?: Settings.ServerSettingsService["Service"]["updateSettings"],
  ) =>
    Layer.mock(Settings.ServerSettingsService)({
      managedPolicy: undefined,
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      updateSettings: (patch) =>
        Ref.update(patches, (all) => [...all, patch]).pipe(
          Effect.andThen(updateSettings?.(patch) ?? Effect.succeed(DEFAULT_SERVER_SETTINGS)),
        ),
    });

  it.effect("refuses keys an agent may not write before touching settings", () =>
    Effect.gen(function* () {
      const patches = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const refusals = yield* Effect.forEach(
        [
          { settings: { enableAgentBrowserAccess: true } },
          { settings: { enableDeviceSupport: true } },
          { settings: { reviewGuideInstructions: "Quote ~/.config/gh/hosts.yml." } },
          { settings: { defaultRuntimeMode: "full-access", keepAwakeWhileAgentsWork: true } },
          { settings: { compactIdleThreads: true } },
          { settings: { previousWorktreesDirectories: [] } },
          { settings: { defaultTheme: "dark" } },
          { settings: { keepAwakeWhileAgentsWork: "yes" } },
          { settings: {} },
        ],
        (params) =>
          call("t3_settings_update", params).pipe(
            Effect.provide(
              layerCaller(Effect.succeed(liveThreadShell(threadId)), recordingSettings(patches)),
            ),
          ),
      );
      expect(refusals.map((result) => (result as { code: string }).code)).toEqual([
        "capability_denied",
        "capability_denied",
        "capability_denied",
        "capability_denied",
        "invalid_request",
        "invalid_request",
        "invalid_request",
        "invalid_request",
        "invalid_request",
      ]);
      expect(refusals[6]).toMatchObject({ message: expect.stringContaining("t3_theme_set") });
      expect(yield* Ref.get(patches)).toEqual([]);
    }),
  );

  it.effect("refuses intervals settings.json cannot hold, and oversized patches", () =>
    Effect.gen(function* () {
      const patches = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const refusals = yield* Effect.forEach(
        [
          { automaticGitFetchInterval: "Infinity" },
          { providerHealthRefreshInterval: "-Infinity" },
          { hostPowerMonitorIdleInterval: "NaN" },
        ],
        (overrides) =>
          call("t3_settings_update", {
            settings: { backgroundActivity: { profile: "custom", overrides } },
          }),
      ).pipe(
        Effect.provide(
          layerCaller(Effect.succeed(liveThreadShell(threadId)), recordingSettings(patches)),
        ),
      );
      const oversized = yield* call("t3_settings_update", {
        settings: { branchNamePrefix: "a".repeat(70_000) },
      }).pipe(
        Effect.provide(
          layerCaller(Effect.succeed(liveThreadShell(threadId)), recordingSettings(patches)),
        ),
      );
      expect([...refusals, oversized].map((result) => (result as { code: string }).code)).toEqual(
        Array(4).fill("invalid_request"),
      );
      expect(yield* Ref.get(patches)).toEqual([]);
    }),
  );

  it.effect("replaces a per-entry map with the whole new value", () =>
    Effect.gen(function* () {
      expect(
        yield* call("t3_settings_update", {
          settings: { usageModelAliases: { "qa/c": "qa/e" } },
        }),
      ).toMatchObject({
        settings: [{ key: "usageModelAliases", changed: true, value: { "qa/c": "qa/e" } }],
      });
      expect(yield* call("t3_settings_update", { settings: { usageModelAliases: {} } })).toEqual({
        settings: [{ key: "usageModelAliases", access: "write", changed: false, value: {} }],
      });
    }).pipe(
      Effect.provide(
        layerCaller(
          Effect.succeed(liveThreadShell(threadId)),
          Settings.ServerSettingsService.layerTest({
            usageModelAliases: { "qa/a": "qa/b", "qa/c": "qa/d" },
          }),
        ),
      ),
    ),
  );

  it.effect("says why no setting can change when settings.json is unreadable", () =>
    Effect.gen(function* () {
      const patches = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const result = yield* call("t3_settings_update", {
        settings: { keepAwakeWhileAgentsWork: false },
      }).pipe(
        Effect.provide(
          layerCaller(
            Effect.succeed(liveThreadShell(threadId)),
            recordingSettings(patches, () =>
              Effect.fail(
                new ServerSettingsError({ settingsPath: "settings.json", operation: "read-file" }),
              ),
            ),
          ),
        ),
      );
      expect(result).toMatchObject({
        code: "orchestration_error",
        message: expect.stringContaining("settings.json could not be read"),
      });
    }),
  );

  it.effect("writes the decoded patch and returns what changed", () =>
    Effect.gen(function* () {
      const patches = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const result = yield* call("t3_settings_update", {
        settings: { branchNamePrefix: "  jl  ", sidebarAutoSettleAfterDays: null },
      }).pipe(
        Effect.provide(
          layerCaller(
            Effect.succeed(liveThreadShell(threadId)),
            recordingSettings(patches, () =>
              Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                branchNamePrefix: "jl",
                sidebarAutoSettleAfterDays: null,
              }),
            ),
          ),
        ),
      );
      expect(yield* Ref.get(patches)).toEqual([
        { branchNamePrefix: "jl", sidebarAutoSettleAfterDays: null },
      ]);
      expect(result).toEqual({
        settings: [
          { key: "branchNamePrefix", access: "write", changed: true, value: "jl" },
          { key: "sidebarAutoSettleAfterDays", access: "write", changed: true, value: null },
        ],
      });
    }),
  );

  it.effect("tells the agent when the administrator's policy locks a setting", () =>
    Effect.gen(function* () {
      const patches = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const result = yield* call("t3_settings_update", {
        settings: { keepAwakeWhileAgentsWork: false },
      }).pipe(
        Effect.provide(
          layerCaller(
            Effect.succeed(liveThreadShell(threadId)),
            recordingSettings(patches, () =>
              Effect.fail(
                new ServerSettingsError({
                  settingsPath: "settings.json",
                  operation: "write-managed-setting",
                  managedSetting: "keepAwakeWhileAgentsWork",
                  managedBy: "Example Corp",
                }),
              ),
            ),
          ),
        ),
      );
      expect(result).toMatchObject({
        code: "capability_denied",
        message: "keepAwakeWhileAgentsWork is managed by Example Corp and cannot be changed.",
      });
    }),
  );

  it.effect("refuses an update when the caller's turn ends while it waits", () =>
    Effect.gen(function* () {
      const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
      const patches = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const checked = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* executor
          .withLock(
            threadId,
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(held);
        const update = yield* call("t3_settings_update", {
          settings: { newWorktreesStartFromOrigin: true },
        }).pipe(Effect.forkChild);
        yield* Deferred.await(checked);
        yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        expect(yield* Fiber.join(update)).toMatchObject({ code: "parent_not_active" });
        expect(yield* Ref.get(patches)).toEqual([]);
      }).pipe(
        Effect.provide(
          layerCaller(
            Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
            recordingSettings(patches),
          ),
        ),
      );
    }),
  );
});

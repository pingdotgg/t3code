import { describe, expect, it } from "@effect/vitest";
import {
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

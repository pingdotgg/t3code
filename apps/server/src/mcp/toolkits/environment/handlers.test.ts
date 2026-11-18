import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentCloudLinkStateResult,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  STATIC_KEYBINDING_COMMANDS,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
  ServerSettingsPatch,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ManagedPolicy from "../../../policy/ManagedPolicy.ts";
import * as CloudLink from "../../../cloud/CloudLink.ts";
import * as ServerConfig from "../../../config.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as DatabaseStorage from "../../../persistence/DatabaseStorage.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Settings from "../../../serverSettings.ts";
import * as StorageCleanup from "../../../storageCleanup.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const cloudLink = (state: EnvironmentCloudLinkStateResult) =>
  Layer.mock(CloudLink.CloudLink)({ linkState: () => Effect.succeed(state) });
const unlinkedCloud = cloudLink({
  linked: false,
  cloudUserId: null,
  relayUrl: null,
  relayIssuer: null,
  publishAgentActivity: false,
});
const threadId = ThreadId.make("thread:preferences");

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      unlinkedCloud,
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
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
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
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
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
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);

const threadScope = (
  overrides: Partial<McpInvocationContext.McpInvocationScope> = {},
): McpInvocationContext.McpInvocationScope => ({
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
  ...overrides,
});

const environmentLayer = <A, E, R>(
  scope: McpInvocationContext.McpInvocationScope,
  caller: OrchestrationV2ThreadShell,
  settings: Layer.Layer<A, E, R>,
  cloud = unlinkedCloud,
  providers: ReadonlyArray<ServerProvider> = [],
  adapterIds: ReadonlyArray<ProviderInstanceId> = [],
) =>
  McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        cloud,
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(caller),
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
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed(adapterIds),
        }),
        settings,
      ),
    ),
  );

const finalResult = <A, E1, R1, E2, R2>(handled: Effect.Effect<Stream.Stream<A, E1, R1>, E2, R2>) =>
  handled.pipe(
    Stream.unwrap,
    Stream.runCollect,
    Effect.map((results) => results.at(-1)),
  );

const countingSettings = (updates: Ref.Ref<number>) =>
  Layer.mock(Settings.ServerSettingsService)({
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    updateSettings: () =>
      Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
    modifySettings: () =>
      Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
    updateProviderInstance: () =>
      Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
  });

// A fresh service per call rereads settings.json, so each build is a server restart.
const restartedSettings = () =>
  Layer.fresh(Settings.layer).pipe(
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: () => Effect.succeedNone,
          set: () => Effect.void,
          create: () => Effect.void,
          getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
          remove: () => Effect.void,
        }),
      ),
    ),
  );

const reloadSettings = Effect.flatMap(
  Settings.ServerSettingsService,
  (service) => service.getSettings,
);

it.layer(
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-environment-preferences-test-" }),
    SqlitePersistence.layerMemory,
  ).pipe(Layer.provideMerge(NodeServices.layer)),
)("sidebar auto-settle preferences", (it) => {
  it.effect("reads, writes, and persists them across restarts", () =>
    Effect.gen(function* () {
      const scope = threadScope();
      const caller = liveThreadShell(threadId);
      yield* Effect.flatMap(Settings.ServerSettingsService, (service) =>
        service.updateSettings({
          enableAgentDeviceAccess: true,
          newWorktreesStartFromOrigin: true,
        }),
      ).pipe(Effect.provide(restartedSettings()));

      yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const read = yield* finalResult(toolkit.handle("t3_environment_read", {}));
        expect(read?.encodedResult).toMatchObject({
          preferences: {
            newWorktreesStartFromOrigin: true,
            sidebarAutoSettleAfterDays: 7,
            sidebarAutoSettleOnMerge: true,
            sidebarAutoSettleKeepPullRequests: false,
          },
        });
        const disabled = yield* finalResult(
          toolkit.handle("t3_environment_preferences_update", {
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
            sidebarAutoSettleKeepPullRequests: true,
            pullRequestMergeMethod: "squash",
            branchNamingMode: "semantic",
            defaultAutoPull: true,
            removeAgentCreditsOnMerge: true,
            worktreeSubmodules: "recursive",
          }),
        );
        expect(disabled?.encodedResult).toMatchObject({
          newWorktreesStartFromOrigin: true,
          sidebarAutoSettleAfterDays: null,
          sidebarAutoSettleOnMerge: false,
          sidebarAutoSettleKeepPullRequests: true,
          pullRequestMergeMethod: "squash",
          branchNamingMode: "semantic",
          reviewGuidesEnabled: false,
          defaultAutoPull: true,
          removeAgentCreditsOnMerge: true,
          worktreeSubmodules: "recursive",
        });
        const omitted = yield* finalResult(
          toolkit.handle("t3_environment_preferences_update", { defaultThreadEnvMode: "worktree" }),
        );
        expect(omitted?.encodedResult).toMatchObject({
          defaultThreadEnvMode: "worktree",
          sidebarAutoSettleAfterDays: null,
          sidebarAutoSettleOnMerge: false,
          sidebarAutoSettleKeepPullRequests: true,
          pullRequestMergeMethod: "squash",
          defaultAutoPull: true,
          worktreeSubmodules: "recursive",
        });
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));

      expect(yield* reloadSettings.pipe(Effect.provide(restartedSettings()))).toMatchObject({
        enableAgentDeviceAccess: true,
        newWorktreesStartFromOrigin: true,
        defaultThreadEnvMode: "worktree",
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
        sidebarAutoSettleKeepPullRequests: true,
        pullRequestMergeMethod: "squash",
        branchNamingMode: "semantic",
        reviewGuidesEnabled: false,
        defaultAutoPull: true,
        removeAgentCreditsOnMerge: true,
        worktreeSubmodules: "recursive",
      });

      yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        yield* finalResult(
          toolkit.handle("t3_environment_preferences_update", {
            sidebarAutoSettleAfterDays: 7,
            sidebarAutoSettleOnMerge: true,
            sidebarAutoSettleKeepPullRequests: false,
          }),
        );
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));

      yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const read = yield* finalResult(toolkit.handle("t3_environment_read", {}));
        expect(read?.encodedResult).toMatchObject({
          preferences: {
            defaultThreadEnvMode: "worktree",
            sidebarAutoSettleAfterDays: 7,
            sidebarAutoSettleOnMerge: true,
            sidebarAutoSettleKeepPullRequests: false,
            pullRequestMergeMethod: "squash",
            branchNamingMode: "semantic",
            reviewGuidesEnabled: false,
            defaultAutoPull: true,
            removeAgentCreditsOnMerge: true,
            worktreeSubmodules: "recursive",
          },
        });
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));
      expect(yield* reloadSettings.pipe(Effect.provide(restartedSettings()))).toMatchObject({
        enableAgentDeviceAccess: true,
        newWorktreesStartFromOrigin: true,
      });
    }),
  );
});

it.effect.each([0, 91])("rejects %s auto-settle days before writing", (days) =>
  Effect.gen(function* () {
    const updates = yield* Ref.make(0);
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      return yield* finalResult(
        toolkit.handle("t3_environment_preferences_update", { sidebarAutoSettleAfterDays: days }),
      );
    }).pipe(
      Effect.provide(
        environmentLayer(threadScope(), liveThreadShell(threadId), countingSettings(updates)),
      ),
    );
    expect(result).toMatchObject({ isFailure: true, failureOrigin: "parameters" });
    expect(yield* Ref.get(updates)).toBe(0);
  }),
);

it.effect.each([
  {
    label: "a read-only client",
    scope: threadScope({
      thread: undefined,
      client: { sessionId: "client:preferences", label: "Client", access: "read-only" },
    }),
    caller: liveThreadShell(threadId),
  },
  {
    label: "an approval-required caller",
    scope: threadScope(),
    caller: liveThreadShell(threadId, { runtimeMode: "approval-required" }),
  },
  {
    label: "a plan-mode caller",
    scope: threadScope(),
    caller: liveThreadShell(threadId, { interactionMode: "plan" }),
  },
  {
    label: "another environment's credential",
    scope: threadScope({ environmentId: EnvironmentId.make("environment:other") }),
    caller: liveThreadShell(threadId),
  },
  {
    label: "a caller whose turn ended",
    scope: threadScope(),
    caller: liveThreadShell(threadId, { activeRunId: null }),
    code: "parent_not_active",
  },
])("denies environment writes from $label", ({ scope, caller, code = "capability_denied" }) =>
  Effect.gen(function* () {
    const updates = yield* Ref.make(0);
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      return yield* finalResult(
        toolkit.handle("t3_environment_preferences_update", {
          sidebarAutoSettleAfterDays: null,
          sidebarAutoSettleOnMerge: false,
          sidebarAutoSettleKeepPullRequests: true,
        }),
      );
    }).pipe(Effect.provide(environmentLayer(scope, caller, countingSettings(updates))));
    expect(result?.result).toMatchObject({ code });
    const instanceWrite = yield* Effect.flatMap(EnvironmentToolkit, (toolkit) =>
      finalResult(
        toolkit.handle("t3_provider_instance_update", {
          instanceId: ProviderInstanceId.make("codex"),
          customModels: ["denied-model"],
        }),
      ),
    ).pipe(Effect.provide(environmentLayer(scope, caller, countingSettings(updates))));
    expect(instanceWrite?.result).toMatchObject({ code });
    expect(yield* Ref.get(updates)).toBe(0);
  }),
);

it.layer(
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-environment-models-test-" }),
    SqlitePersistence.layerMemory,
  ).pipe(Layer.provideMerge(NodeServices.layer)),
)("model preferences", (it) => {
  it.effect("applies each incremental op and persists it across restarts", () =>
    Effect.gen(function* () {
      const scope = threadScope();
      const caller = liveThreadShell(threadId);
      const provider = ProviderInstanceId.make("codex_work");
      const read = Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        return (yield* finalResult(toolkit.handle("t3_environment_read", {})))?.encodedResult;
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));

      yield* Effect.flatMap(Settings.ServerSettingsService, (service) =>
        service.updateSettings({
          favorites: [{ provider, model: "luna" }],
          providerModelPreferences: { [provider]: { hiddenModels: ["astra"], modelOrder: [] } },
        }),
      ).pipe(Effect.provide(restartedSettings()));
      expect(yield* read).toMatchObject({
        preferences: {
          favorites: [{ provider, model: "luna" }],
          providerModelPreferences: {
            [provider]: {
              hiddenModels: ["astra"],
              modelOrder: [],
              defaultModel: null,
              defaultOptions: [],
            },
          },
        },
      });

      const omitted = yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const update = "t3_environment_preferences_update";
        yield* finalResult(
          toolkit.handle(update, {
            setModelFavorites: [
              { provider, model: "sol", favorite: true },
              { provider, model: "luna", favorite: false },
            ],
          }),
        );
        yield* finalResult(
          toolkit.handle(update, { setModelsHidden: [{ provider, model: "nova", hidden: true }] }),
        );
        yield* finalResult(
          toolkit.handle(update, {
            setProviderModelOrder: { provider, modelOrder: ["sol", "luna"] },
          }),
        );
        yield* finalResult(
          toolkit.handle(update, {
            setProviderModelDefault: {
              provider,
              defaultModel: "sol",
              defaultOptions: [{ id: "reasoningEffort", value: "high" }],
            },
          }),
        );
        return yield* finalResult(toolkit.handle(update, { defaultThreadEnvMode: "worktree" }));
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));
      const expected = {
        favorites: [{ provider, model: "sol" }],
        providerModelPreferences: {
          [provider]: {
            hiddenModels: ["astra", "nova"],
            modelOrder: ["sol", "luna"],
            defaultModel: "sol",
            defaultOptions: [{ id: "reasoningEffort", value: "high" }],
          },
        },
      };
      expect(omitted?.encodedResult).toMatchObject(expected);
      expect(yield* reloadSettings.pipe(Effect.provide(restartedSettings()))).toMatchObject(
        expected,
      );
      expect(yield* read).toMatchObject({ preferences: expected });

      yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        yield* finalResult(
          toolkit.handle("t3_environment_preferences_update", {
            setProviderModelDefault: { provider, defaultModel: null },
          }),
        );
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));
      expect(yield* read).toMatchObject({
        preferences: {
          providerModelPreferences: {
            [provider]: {
              defaultModel: null,
              defaultOptions: [{ id: "reasoningEffort", value: "high" }],
            },
          },
        },
      });
    }),
  );
});

it.layer(
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-environment-idle-test-" }),
    SqlitePersistence.layerMemory,
  ).pipe(Layer.provideMerge(NodeServices.layer)),
)("idle compaction and limited-thread snooze", (it) => {
  it.effect("reads the effective mode and keeps the legacy switch consistent", () =>
    Effect.gen(function* () {
      const scope = threadScope();
      const caller = liveThreadShell(threadId);
      const read = Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        return (yield* finalResult(toolkit.handle("t3_environment_read", {})))?.encodedResult;
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));
      const update = (
        patch: Pick<
          ServerSettingsPatch,
          "idleCompaction" | "snoozeLimitedThreads" | "defaultThreadEnvMode"
        >,
      ) =>
        Effect.gen(function* () {
          const toolkit = yield* EnvironmentToolkit;
          return yield* finalResult(toolkit.handle("t3_environment_preferences_update", patch));
        }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));

      // Only the legacy boolean, as written by a client from before modes.
      yield* Effect.flatMap(Settings.ServerSettingsService, (service) =>
        service.updateSettings({ compactIdleThreads: true }),
      ).pipe(Effect.provide(restartedSettings()));
      expect(yield* read).toMatchObject({
        preferences: { idleCompaction: "beforeCacheExpires", snoozeLimitedThreads: false },
      });

      expect(
        (yield* update({ idleCompaction: "off", snoozeLimitedThreads: true }))?.encodedResult,
      ).toMatchObject({ idleCompaction: "off", snoozeLimitedThreads: true });
      expect(yield* reloadSettings.pipe(Effect.provide(restartedSettings()))).toMatchObject({
        idleCompaction: "off",
        compactIdleThreads: false,
        snoozeLimitedThreads: true,
      });

      yield* update({ idleCompaction: "beforeCacheExpires" });
      yield* update({ defaultThreadEnvMode: "worktree" });
      expect(yield* reloadSettings.pipe(Effect.provide(restartedSettings()))).toMatchObject({
        idleCompaction: "beforeCacheExpires",
        compactIdleThreads: true,
        snoozeLimitedThreads: true,
      });
      expect(yield* read).toMatchObject({
        preferences: { idleCompaction: "beforeCacheExpires", snoozeLimitedThreads: true },
      });

      yield* update({ snoozeLimitedThreads: false });
      expect(yield* read).toMatchObject({
        preferences: { idleCompaction: "beforeCacheExpires", snoozeLimitedThreads: false },
      });
    }),
  );
});

it.layer(
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-environment-resume-test-" }),
    SqlitePersistence.layerMemory,
  ).pipe(Layer.provideMerge(NodeServices.layer)),
)("resume, streaming, and default runtime mode", (it) => {
  it.effect("never lets an agent change the owner's controls over what agents receive", () =>
    Effect.gen(function* () {
      const scope = threadScope();
      const caller = liveThreadShell(threadId);
      const ownerOnly = {
        t3AgentInstructions: false,
        claudeInstructionFiles: false,
        claudeAutoMemory: false,
        claudeGitContext: false,
        claudeSkillList: false,
        claudeContextLists: false,
        claudeHooks: false,
        t3ContextHandoff: false,
        t3SideChatContext: false,
        t3RestartNote: false,
        t3WakeOnDelegateFinished: false,
        t3WakeOnDelegateQuestion: false,
        t3WakeOnPullRequestUpdate: false,
        t3GoalContinuation: false,
        agentMessagePolicy: "block",
        requestRewriteRules: [
          {
            id: "rule",
            name: "Rule",
            enabled: true,
            action: "add",
            target: "system",
            text: "Injected by an agent.",
          },
        ],
      } as const;
      const stored = reloadSettings.pipe(Effect.provide(restartedSettings()));
      const before = yield* stored;
      yield* Effect.flatMap(EnvironmentToolkit, (toolkit) =>
        finalResult(
          toolkit.handle("t3_environment_preferences_update", {
            ...ownerOnly,
            snoozeLimitedThreads: !before.snoozeLimitedThreads,
          } as never),
        ),
      ).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())), Effect.exit);
      const after = yield* stored;
      for (const key of Object.keys(ownerOnly) as Array<keyof typeof ownerOnly>) {
        expect([key, after[key]]).toEqual([key, before[key]]);
      }
      const read = yield* Effect.flatMap(EnvironmentToolkit, (toolkit) =>
        finalResult(toolkit.handle("t3_environment_read", {})),
      ).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));
      expect(read?.encodedResult).toMatchObject({
        preferences: { claudeHooks: true, agentMessagePolicy: "allow" },
      });
    }),
  );

  it.effect("round-trips the unrestricted fields and only lowers defaultRuntimeMode", () =>
    Effect.gen(function* () {
      const scope = threadScope();
      const caller = liveThreadShell(threadId);
      const update = (
        patch: Pick<
          ServerSettingsPatch,
          | "autoResumeLimitedThreads"
          | "continueThreadsAfterServerUpdate"
          | "responseStreamingMode"
          | "defaultRuntimeMode"
        >,
      ) =>
        Effect.flatMap(EnvironmentToolkit, (toolkit) =>
          finalResult(toolkit.handle("t3_environment_preferences_update", patch)),
        ).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));
      const read = Effect.flatMap(EnvironmentToolkit, (toolkit) =>
        finalResult(toolkit.handle("t3_environment_read", {})),
      ).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));
      const stored = reloadSettings.pipe(Effect.provide(restartedSettings()));

      const written = yield* update({
        autoResumeLimitedThreads: true,
        continueThreadsAfterServerUpdate: false,
        responseStreamingMode: "turn",
        defaultRuntimeMode: "auto",
      });
      const expected = {
        autoResumeLimitedThreads: true,
        continueThreadsAfterServerUpdate: false,
        responseStreamingMode: "turn",
        defaultRuntimeMode: "auto",
      };
      expect(written?.encodedResult).toMatchObject(expected);
      expect(yield* stored).toMatchObject(expected);
      expect((yield* read)?.encodedResult).toMatchObject({ preferences: expected });

      const raised = yield* update({ defaultRuntimeMode: "full-access" });
      expect(raised?.result).toMatchObject({
        code: "runtime_mode_escalation_denied",
        message: "defaultRuntimeMode can only be lowered by agents; raise it in Settings.",
      });
      expect((yield* stored).defaultRuntimeMode).toBe("auto");

      yield* update({ defaultRuntimeMode: "approval-required" });
      expect(yield* stored).toMatchObject({ ...expected, defaultRuntimeMode: "approval-required" });
    }),
  );
});

it.layer(
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-environment-global-defaults-test-" }),
    SqlitePersistence.layerMemory,
  ).pipe(Layer.provideMerge(NodeServices.layer)),
)("global model defaults", (it) => {
  it.effect("reads, writes, resets, and persists them", () =>
    Effect.gen(function* () {
      const scope = threadScope();
      const caller = liveThreadShell(threadId);
      const claude = ProviderInstanceId.make("claudeAgent");
      const codex = ProviderInstanceId.make("codex");
      const update = (
        patch: Pick<
          ServerSettingsPatch,
          | "defaultModelSelection"
          | "textGenerationModelSelection"
          | "sourceControlWriterModelSelection"
          | "reviewGuideModelSelection"
          | "defaultThreadEnvMode"
        >,
      ) =>
        Effect.flatMap(EnvironmentToolkit, (toolkit) =>
          finalResult(toolkit.handle("t3_environment_preferences_update", patch)),
        ).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));
      const read = Effect.flatMap(EnvironmentToolkit, (toolkit) =>
        finalResult(toolkit.handle("t3_environment_read", {})),
      ).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));
      const stored = reloadSettings.pipe(Effect.provide(restartedSettings()));

      const written = yield* update({
        defaultModelSelection: {
          instanceId: claude,
          model: "claude-fable-5-1",
          options: [{ id: "thinking", value: false }],
        },
        textGenerationModelSelection: {
          instanceId: codex,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        sourceControlWriterModelSelection: { instanceId: codex, model: "gpt-5.4-mini" },
        reviewGuideModelSelection: { instanceId: claude, model: "claude-opus-4-6" },
      });
      const expected = {
        defaultModelSelection: {
          instanceId: claude,
          model: "claude-fable-5-1",
          options: [{ id: "thinking", value: false }],
        },
        textGenerationModelSelection: {
          instanceId: codex,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        sourceControlWriterModelSelection: { instanceId: codex, model: "gpt-5.4-mini" },
        reviewGuideModelSelection: { instanceId: claude, model: "claude-opus-4-6" },
      };
      expect(written?.encodedResult).toMatchObject(expected);
      expect(yield* stored).toMatchObject(expected);
      expect((yield* read)?.encodedResult).toMatchObject({ preferences: expected });

      // Omitting the fields preserves every default.
      const omitted = yield* update({ defaultThreadEnvMode: "worktree" });
      expect(omitted?.encodedResult).toMatchObject(expected);
      expect(yield* stored).toMatchObject({ ...expected, defaultThreadEnvMode: "worktree" });

      // Two independent patches preserve each other's fields; null resets only
      // the nullable selections.
      yield* update({ sourceControlWriterModelSelection: null });
      const second = yield* update({ reviewGuideModelSelection: null });
      expect(second?.encodedResult).toMatchObject({
        defaultModelSelection: expected.defaultModelSelection,
        textGenerationModelSelection: expected.textGenerationModelSelection,
        sourceControlWriterModelSelection: null,
        reviewGuideModelSelection: null,
      });
      expect(yield* stored).toMatchObject({
        defaultModelSelection: expected.defaultModelSelection,
        sourceControlWriterModelSelection: null,
        reviewGuideModelSelection: null,
      });

      // Null resets the environment default model and reads back as null.
      const reset = yield* update({ defaultModelSelection: null });
      expect(reset?.encodedResult).toMatchObject({
        defaultModelSelection: null,
        sourceControlWriterModelSelection: null,
        reviewGuideModelSelection: null,
      });
      expect(yield* stored).toMatchObject({ defaultModelSelection: null });
      expect((yield* read)?.encodedResult).toMatchObject({
        preferences: { defaultModelSelection: null },
      });
    }),
  );

  it.effect("rejects a null text-generation selection before writing", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make(0);
      const result = yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        return yield* finalResult(
          toolkit.handle("t3_environment_preferences_update", {
            textGenerationModelSelection: null,
          }),
        );
      }).pipe(
        Effect.provide(
          environmentLayer(threadScope(), liveThreadShell(threadId), countingSettings(updates)),
        ),
      );
      expect(result).toMatchObject({ isFailure: true, failureOrigin: "parameters" });
      expect(yield* Ref.get(updates)).toBe(0);
    }),
  );
});

// The real secret store, so stored API keys and sensitive environment values
// survive a restart the way they do in production.
const restartedSettingsWithSecrets = () =>
  Layer.fresh(Settings.layer).pipe(
    Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layerTest())),
    Layer.provide(NodeCrypto.layer),
  );

it.layer(
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-environment-instances-test-" }),
    SqlitePersistence.layerMemory,
  ).pipe(Layer.provideMerge(NodeServices.layer)),
)("provider instance metadata", (it) => {
  it.effect("edits custom models and labels without exposing or dropping secrets", () =>
    Effect.gen(function* () {
      const scope = threadScope();
      const caller = liveThreadShell(threadId);
      const work = ProviderInstanceId.make("opencode_work");
      const antigravity = ProviderInstanceId.make("antigravity_work");
      const pi = ProviderInstanceId.make("pi_work");
      const fork = ProviderInstanceId.make("fork_work");
      const serverPassword = "canary-server-password-4f1d";
      const envSecret = "canary-env-secret-9b2e";
      yield* Effect.flatMap(Settings.ServerSettingsService, (service) =>
        service.updateSettings({
          providerInstances: {
            [work]: {
              driver: ProviderDriverKind.make("opencode"),
              displayName: "Work",
              enabled: false,
              config: { serverPassword, customModels: ["old-model"] },
              environment: [{ name: "SECRET_TOKEN", value: envSecret, sensitive: true }],
            },
            [pi]: {
              driver: ProviderDriverKind.make("pi"),
              config: { customModels: ["keep", "drop"], modelConcurrency: { keep: 2, drop: 3 } },
            },
            [fork]: { driver: ProviderDriverKind.make("forkOnly") },
            [antigravity]: { driver: ProviderDriverKind.make("antigravity") },
          },
        }),
      ).pipe(Effect.provide(restartedSettingsWithSecrets()));
      const outputs: Array<unknown> = [];
      const call = (params: Schema.Json) =>
        Effect.flatMap(EnvironmentToolkit, (toolkit) =>
          finalResult(toolkit.handle("t3_provider_instance_update", params)),
        ).pipe(
          Effect.tap((result) => Effect.sync(() => outputs.push(result))),
          Effect.provide(environmentLayer(scope, caller, restartedSettingsWithSecrets())),
        );
      const read = Effect.flatMap(EnvironmentToolkit, (toolkit) =>
        finalResult(toolkit.handle("t3_environment_read", {})),
      ).pipe(
        Effect.tap((result) => Effect.sync(() => outputs.push(result))),
        Effect.provide(environmentLayer(scope, caller, restartedSettingsWithSecrets())),
      );
      const stored = reloadSettings.pipe(Effect.provide(restartedSettingsWithSecrets()));

      expect((yield* read)?.encodedResult).toMatchObject({
        preferences: {
          providerInstances: {
            codex: { driver: "codex", enabled: true, customModels: [] },
            [work]: {
              driver: "opencode",
              displayName: "Work",
              accentColor: null,
              enabled: false,
              customModels: ["old-model"],
            },
          },
        },
      });

      const edited = yield* call({
        instanceId: work,
        customModels: ["new-model", { slug: "named", name: "Named" }],
        displayName: null,
        accentColor: "violet",
      });
      expect(edited?.encodedResult).toEqual({
        driver: "opencode",
        displayName: null,
        accentColor: "violet",
        enabled: false,
        customModels: ["new-model", { slug: "named", name: "Named" }],
      });
      const afterEdit = yield* stored;
      expect(afterEdit.providerInstances[work]).toMatchObject({
        enabled: false,
        accentColor: "violet",
        config: { serverPassword, customModels: ["new-model", { slug: "named", name: "Named" }] },
        environment: [{ name: "SECRET_TOKEN", value: envSecret, sensitive: true }],
      });
      expect(afterEdit.providerInstances[work]?.displayName).toBeUndefined();

      yield* call({ instanceId: pi, customModels: ["keep"] });
      expect((yield* stored).providerInstances[pi]?.config).toMatchObject({
        customModels: ["keep"],
        modelConcurrency: { keep: 2 },
      });

      // An implicit built-in default instance is stored on first edit.
      yield* call({ instanceId: ProviderInstanceId.make("codex"), displayName: "Personal" });
      expect((yield* stored).providerInstances[ProviderInstanceId.make("codex")]).toEqual({
        driver: "codex",
        displayName: "Personal",
      });

      const before = yield* stored;
      for (const refused of [
        { instanceId: ProviderInstanceId.make("missing"), displayName: "Nope" },
        { instanceId: fork, customModels: ["x"] },
        { instanceId: antigravity, customModels: ["hidden-in-settings"] },
      ]) {
        expect((yield* call(refused))?.result).toMatchObject({ code: "invalid_request" });
      }
      expect(yield* stored).toEqual(before);
      yield* read;

      const config = yield* ServerConfig.ServerConfig;
      const disk = yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.readFileString(config.settingsPath),
      );
      for (const canary of [serverPassword, envSecret]) {
        expect(JSON.stringify(outputs)).not.toContain(canary);
        expect(disk).not.toContain(canary);
      }
    }),
  );

  it.effect("a metadata edit never enables an instance a project override turned on", () =>
    Effect.gen(function* () {
      const cursor = ProviderInstanceId.make("cursor");
      const projectId = ProjectId.make("project:cursor-on");
      yield* Effect.flatMap(Settings.ServerSettingsService, (service) =>
        service.updateSettings({
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [cursor]: { enabled: true } } },
          },
        }),
      ).pipe(Effect.provide(restartedSettingsWithSecrets()));
      const edited = yield* Effect.flatMap(EnvironmentToolkit, (toolkit) =>
        finalResult(
          toolkit.handle("t3_provider_instance_update", {
            instanceId: cursor,
            displayName: "Cursor",
          }),
        ),
      ).pipe(
        Effect.provide(
          environmentLayer(
            threadScope(),
            liveThreadShell(threadId),
            restartedSettingsWithSecrets(),
          ),
        ),
      );
      expect(edited?.encodedResult).toMatchObject({ displayName: "Cursor", enabled: false });
      const stored = yield* reloadSettings.pipe(Effect.provide(restartedSettingsWithSecrets()));
      expect(resolveProjectProviderInstanceEnabled(stored, null, cursor)).toBe(false);
      expect(stored.providerInstances[cursor]).toEqual({ driver: "cursor", displayName: "Cursor" });
    }),
  );
});

const staticSettings = Layer.mock(Settings.ServerSettingsService)({
  getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-environment-keybindings-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("keybindings", (it) => {
  // A fresh service per call rereads keybindings.json, so each call is a server restart.
  const provide = <A, E, R>(
    program: Effect.Effect<A, E, R>,
    scope: McpInvocationContext.McpInvocationScope = threadScope(),
    caller = liveThreadShell(threadId),
  ) =>
    program.pipe(
      Effect.provide(
        environmentLayer(
          scope,
          caller,
          Layer.merge(staticSettings, Layer.fresh(Keybindings.layer)),
        ),
      ),
    );
  const list = provide(
    Effect.flatMap(EnvironmentToolkit, (toolkit) =>
      finalResult(toolkit.handle("t3_keybindings_list", {})),
    ),
  );
  const upsert = (
    params: { readonly key: string; readonly command: string },
    scope?: McpInvocationContext.McpInvocationScope,
  ) =>
    provide(
      Effect.flatMap(EnvironmentToolkit, (toolkit) =>
        finalResult(toolkit.handle("t3_keybinding_upsert", params)),
      ),
      scope,
    );
  const custom = {
    command: "chat.new",
    shortcut: expect.objectContaining({ key: "9", modKey: true, shiftKey: true }),
  };
  const withCustom = { keybindings: expect.arrayContaining([custom]) };

  it.effect("lists, upserts, and removes custom rules across restarts", () =>
    Effect.gen(function* () {
      const before = yield* list;
      expect(before?.isFailure).toBe(false);
      expect(before?.encodedResult).toMatchObject({ issues: [] });
      expect(before?.encodedResult).not.toMatchObject(withCustom);

      const upserted = yield* upsert({ key: "mod+shift+9", command: "chat.new" });
      expect(upserted?.encodedResult).toMatchObject(withCustom);
      expect((yield* list)?.encodedResult).toMatchObject(withCustom);

      const removed = yield* provide(
        Effect.flatMap(EnvironmentToolkit, (toolkit) =>
          finalResult(
            toolkit.handle("t3_keybinding_remove", { key: "mod+shift+9", command: "chat.new" }),
          ),
        ),
      );
      expect(removed?.encodedResult).not.toMatchObject(withCustom);
      expect((yield* list)?.encodedResult).not.toMatchObject(withCustom);
    }),
  );

  it.effect("rejects an unknown command with a typed failure and zero writes", () =>
    Effect.gen(function* () {
      const before = (yield* list)?.encodedResult;
      const writes = yield* Ref.make(0);
      const refused = (
        tool: "t3_keybinding_upsert" | "t3_keybinding_remove",
        params:
          | { readonly key: string; readonly command: string }
          | {
              readonly key: string;
              readonly command: string;
              readonly replace: { readonly key: string; readonly command: string };
            },
      ) =>
        Effect.flatMap(EnvironmentToolkit, (toolkit) =>
          finalResult(toolkit.handle(tool, params)),
        ).pipe(
          Effect.provide(
            environmentLayer(
              threadScope(),
              liveThreadShell(threadId),
              Layer.merge(
                staticSettings,
                Layer.mock(Keybindings.Keybindings)({
                  upsertKeybindingRule: () =>
                    Ref.update(writes, (count) => count + 1).pipe(
                      Effect.as({ keybindings: [], issues: [] }),
                    ),
                  removeKeybindingRule: () =>
                    Ref.update(writes, (count) => count + 1).pipe(
                      Effect.as({ keybindings: [], issues: [] }),
                    ),
                }),
              ),
            ),
          ),
        );
      for (const [tool, params] of [
        ["t3_keybinding_upsert", { key: "mod+shift+8", command: "script.Not Valid.run" }],
        [
          "t3_keybinding_upsert",
          {
            key: "mod+shift+8",
            command: "chat.new",
            replace: { key: "mod+shift+8", command: "script.Not Valid.run" },
          },
        ],
        ["t3_keybinding_remove", { key: "mod+shift+8", command: "script.Not Valid.run" }],
      ] as const) {
        const result = yield* refused(tool, params);
        expect(result).toMatchObject({
          isFailure: true,
          result: {
            code: "invalid_request",
            // The message must carry the contract's static ids so an agent can
            // pick a valid command without another discovery round-trip.
            message: `Unknown keybinding command \`script.Not Valid.run\`. Valid commands: ${STATIC_KEYBINDING_COMMANDS.join(", ")}, or \`script.<id>.run\` for a project script (\`<id>\`: lowercase letters, digits and hyphens, at most 24 characters).`,
          },
        });
      }
      expect(yield* Ref.get(writes)).toBe(0);
      expect((yield* list)?.encodedResult).toEqual(before);
    }),
  );

  it.effect.each([
    {
      label: "a read-only client",
      scope: threadScope({
        thread: undefined,
        client: { sessionId: "client:keybindings", label: "Client", access: "read-only" },
      }),
      caller: liveThreadShell(threadId),
    },
    {
      label: "an approval-required caller",
      scope: threadScope(),
      caller: liveThreadShell(threadId, { runtimeMode: "approval-required" }),
    },
    {
      label: "another environment's credential",
      scope: threadScope({ environmentId: EnvironmentId.make("environment:other") }),
      caller: liveThreadShell(threadId),
    },
    {
      label: "a caller whose turn ended",
      scope: threadScope(),
      caller: liveThreadShell(threadId, { activeRunId: null }),
      code: "parent_not_active",
    },
  ])("denies keybinding writes from $label", ({ scope, caller, code = "capability_denied" }) =>
    Effect.gen(function* () {
      yield* upsert({ key: "mod+shift+9", command: "chat.new" });
      const before = (yield* list)?.encodedResult;
      const handle = (
        tool: "t3_keybinding_upsert" | "t3_keybinding_remove",
        params: { readonly key: string; readonly command: string },
      ) =>
        provide(
          Effect.flatMap(EnvironmentToolkit, (toolkit) =>
            finalResult(toolkit.handle(tool, params)),
          ),
          scope,
          caller,
        );
      const upserted = yield* handle("t3_keybinding_upsert", {
        key: "mod+shift+7",
        command: "chat.new",
      });
      const removed = yield* handle("t3_keybinding_remove", {
        key: "mod+shift+9",
        command: "chat.new",
      });
      expect(upserted?.result).toMatchObject({ code });
      expect(removed?.result).toMatchObject({ code });
      expect((yield* list)?.encodedResult).toEqual(before);
      yield* provide(
        Effect.flatMap(EnvironmentToolkit, (toolkit) =>
          finalResult(
            toolkit.handle("t3_keybinding_remove", { key: "mod+shift+9", command: "chat.new" }),
          ),
        ),
      );
    }),
  );
});

it.effect.each([
  {
    label: "unlinked",
    state: {
      linked: false,
      cloudUserId: null,
      relayUrl: null,
      relayIssuer: null,
      publishAgentActivity: false,
    },
    connect: {
      linked: false,
      linkRevoked: false,
      managedTunnelActive: false,
      publishAgentActivity: false,
      holdWebhooksWhileOffline: false,
      reachability: null,
    },
  },
  {
    label: "linked",
    state: {
      linked: true,
      cloudUserId: "user:secret-account",
      relayUrl: "wss://secret-relay.example",
      relayIssuer: "secret-issuer",
      managedTunnelActive: true,
      publishAgentActivity: true,
      holdWebhooksWhileOffline: true,
      linkRevoked: false,
      reachability: {
        status: "unreachable",
        checkedAt: "2026-10-25T00:00:00.000Z",
        cause: "edge_unreachable",
        reason: "secret-host.example:7844 refused",
        hint: null,
        fix: "Open port 7844.",
      },
    },
    connect: {
      linked: true,
      linkRevoked: false,
      managedTunnelActive: true,
      publishAgentActivity: true,
      holdWebhooksWhileOffline: true,
      reachability: {
        status: "unreachable",
        checkedAt: "2026-10-25T00:00:00.000Z",
        cause: "edge_unreachable",
      },
    },
  },
] satisfies ReadonlyArray<{
  label: string;
  state: EnvironmentCloudLinkStateResult;
  connect: unknown;
}>)("reads the $label Connect summary without identifiers", ({ state, connect }) =>
  Effect.gen(function* () {
    const result = yield* Effect.flatMap(EnvironmentToolkit, (toolkit) =>
      finalResult(toolkit.handle("t3_environment_read", {})),
    ).pipe(
      Effect.provide(
        environmentLayer(
          threadScope(),
          liveThreadShell(threadId),
          staticSettings,
          cloudLink(state),
        ),
      ),
    );
    expect(result?.encodedResult).toMatchObject({ connect });
    const output = JSON.stringify(result?.encodedResult);
    for (const forbidden of [
      "cloudUserId",
      "relayUrl",
      "relayIssuer",
      "endpointRuntimeStatus",
      "secret",
      "7844",
    ]) {
      expect(output).not.toContain(forbidden);
    }
  }),
);

it.effect("reports storage totals without paths, titles, or commands", () =>
  Effect.gen(function* () {
    const result = yield* Effect.flatMap(EnvironmentToolkit, (toolkit) =>
      finalResult(toolkit.handle("t3_environment_storage_report", {})),
    ).pipe(
      Effect.provide(
        environmentLayer(
          threadScope(),
          liveThreadShell(threadId),
          Layer.mergeAll(
            staticSettings,
            Layer.mock(StorageCleanup.StorageCleanup)({
              latestReport: Effect.succeed({
                trigger: "automatic",
                startedAt: "2026-10-25T00:00:00.000Z",
                finishedAt: "2026-10-25T00:00:01.000Z",
                entries: [
                  {
                    kind: "worktree",
                    outcome: "removed",
                    reason: "merged",
                    path: "/secret/worktree",
                    projectPath: "/secret/project",
                    threadId,
                    threadTitle: "Private title",
                    bytes: 10,
                    files: 1,
                  },
                ],
                counts: { removed: 1, kept: 0, failed: 0 },
                omittedCount: 4,
                bytesFreed: 10,
              }),
            }),
            Layer.mock(DatabaseStorage.DatabaseStorage)({
              status: Stream.make({
                databaseBytes: 3 * 1024 ** 3,
                reclaimableBytes: 2 * 1024 ** 3,
                incrementalVacuumEnabled: false,
                compactCommand: "t3 doctor --base-dir /secret/home",
              }),
            }),
          ),
        ),
      ),
    );
    expect(result?.encodedResult).toEqual({
      database: {
        databaseBytes: 3 * 1024 ** 3,
        reclaimableBytes: 2 * 1024 ** 3,
        incrementalVacuumEnabled: false,
        compactionRecommended: true,
      },
      lastCleanup: {
        trigger: "automatic",
        startedAt: "2026-10-25T00:00:00.000Z",
        finishedAt: "2026-10-25T00:00:01.000Z",
        counts: { removed: 1, kept: 0, failed: 0 },
        bytesFreed: 10,
        entryCount: 5,
      },
    });
  }),
);

const codexInstance = ProviderInstanceId.make("codex");
const tierCandidate = (minHeadroomPercent?: number) => ({
  providerInstanceId: codexInstance,
  model: "gpt-5.4",
  ...(minHeadroomPercent === undefined ? {} : { minHeadroomPercent }),
});
const codexProvider = (): ServerProvider => ({
  instanceId: codexInstance,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-02T00:00:00.000Z",
  models: [{ slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});
const countingSeededSettings = (seed: Partial<ServerSettings>, updates: Ref.Ref<number>) =>
  Layer.mock(Settings.ServerSettingsService)({
    getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, ...seed }),
    updateSettings: () =>
      Ref.update(updates, (count) => count + 1).pipe(
        Effect.as({ ...DEFAULT_SERVER_SETTINGS, ...seed }),
      ),
    modifySettings: (patch) => {
      const seeded = { ...DEFAULT_SERVER_SETTINGS, ...seed };
      return Ref.update(updates, (count) => count + 1).pipe(
        Effect.as(applyServerSettingsPatch(seeded, patch(seeded))),
      );
    },
    updateProviderInstance: () =>
      Ref.update(updates, (count) => count + 1).pipe(
        Effect.as({ ...DEFAULT_SERVER_SETTINGS, ...seed }),
      ),
  });

it.effect("upserts a delegation tier, returns before/after, and shows tiers on read", () =>
  Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit;
    const service = yield* Settings.ServerSettingsService;
    const result = yield* finalResult(
      toolkit.handle("t3_environment_preferences_update", {
        setDelegationTier: {
          tier: "small",
          candidates: [tierCandidate(30)],
        },
      }),
    );
    expect(result?.encodedResult).toMatchObject({
      delegationTierChange: {
        tier: "small",
        before: [tierCandidate(20)],
        after: [tierCandidate(30)],
      },
    });
    expect((yield* service.getSettings).delegationTiers.small).toMatchObject([tierCandidate(30)]);
    const read = yield* finalResult(toolkit.handle("t3_environment_read", {}));
    expect(read?.encodedResult).toMatchObject({
      preferences: { delegationTiers: { small: [tierCandidate(30)] } },
    });
  }).pipe(
    Effect.provide(
      environmentLayer(
        threadScope(),
        liveThreadShell(threadId),
        Settings.layerTest({
          delegationTiers: { small: [tierCandidate(20)], medium: [], large: [] },
        }),
        unlinkedCloud,
        [codexProvider()],
        [codexInstance],
      ),
    ),
  ),
);

it.effect("refuses unknown and hidden tier candidates with no write", () =>
  Effect.gen(function* () {
    const updates = yield* Ref.make(0);
    const run = (
      candidates: ReadonlyArray<{
        providerInstanceId: ProviderInstanceId;
        model: string;
        minHeadroomPercent?: number;
      }>,
    ) =>
      Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        return yield* finalResult(
          toolkit.handle("t3_environment_preferences_update", {
            setDelegationTier: { tier: "small", candidates: [...candidates] },
          }),
        );
      }).pipe(
        Effect.provide(
          environmentLayer(
            threadScope(),
            liveThreadShell(threadId),
            countingSeededSettings(
              {
                providerModelPreferences: {
                  [codexInstance]: { hiddenModels: ["gpt-5.4"], modelOrder: [] },
                },
              },
              updates,
            ),
            unlinkedCloud,
            [codexProvider()],
            [codexInstance],
          ),
        ),
      );
    const unknown = yield* run([
      { providerInstanceId: ProviderInstanceId.make("unknown"), model: "gpt-5.4" },
    ]);
    expect(unknown?.result).toMatchObject({ code: "invalid_request" });
    const hidden = yield* run([tierCandidate()]);
    expect(hidden?.result).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("hidden"),
    });
    expect(yield* Ref.get(updates)).toBe(0);
  }),
);

it.effect("refuses lowering a tier's minimum headroom with no write", () =>
  Effect.gen(function* () {
    const updates = yield* Ref.make(0);
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      return yield* finalResult(
        toolkit.handle("t3_environment_preferences_update", {
          setDelegationTier: { tier: "small", candidates: [tierCandidate(10)] },
        }),
      );
    }).pipe(
      Effect.provide(
        environmentLayer(
          threadScope(),
          liveThreadShell(threadId),
          countingSeededSettings(
            { delegationTiers: { small: [tierCandidate(20)], medium: [], large: [] } },
            updates,
          ),
          unlinkedCloud,
          [codexProvider()],
          [codexInstance],
        ),
      ),
    );
    expect(result?.result).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("Settings"),
    });
    expect(yield* Ref.get(updates)).toBe(0);
  }),
);

it.effect(
  "refuses clearing, swapping away, or undercutting a guarded candidate and allows reordering",
  () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make(0);
      const candidate = (model: string, minHeadroomPercent?: number) => ({
        providerInstanceId: codexInstance,
        model,
        ...(minHeadroomPercent === undefined ? {} : { minHeadroomPercent }),
      });
      const stored = [candidate("gpt-5.4", 30), candidate("gpt-5.3", 10)];
      const run = (candidates: ReadonlyArray<ReturnType<typeof candidate>> | null) =>
        Effect.gen(function* () {
          const toolkit = yield* EnvironmentToolkit;
          return yield* finalResult(
            toolkit.handle("t3_environment_preferences_update", {
              setDelegationTier: {
                tier: "small",
                candidates: candidates === null ? null : [...candidates],
              },
            }),
          );
        }).pipe(
          Effect.provide(
            environmentLayer(
              threadScope(),
              liveThreadShell(threadId),
              countingSeededSettings(
                { delegationTiers: { small: stored, medium: [], large: [] } },
                updates,
              ),
              unlinkedCloud,
              [
                {
                  ...codexProvider(),
                  models: ["gpt-5.4", "gpt-5.3", "gpt-5.2"].map((slug) => ({
                    slug,
                    name: slug,
                    isCustom: false,
                    capabilities: null,
                  })),
                },
              ],
              [codexInstance],
            ),
          ),
        );
      const refusals = yield* Effect.all([
        run(null),
        run([candidate("gpt-5.4", 0)]),
        run([candidate("gpt-5.2", 0), candidate("gpt-5.3", 10)]),
        run([candidate("gpt-5.4", 30), candidate("gpt-5.3", 10), candidate("gpt-5.2", 0)]),
      ]);
      for (const refusal of refusals)
        expect(refusal?.result).toMatchObject({
          code: "invalid_request",
          message: expect.stringContaining("Settings"),
        });
      expect(yield* Ref.get(updates)).toBe(0);
      const reordered = yield* run([candidate("gpt-5.3", 10), candidate("gpt-5.4", 30)]);
      expect(reordered?.encodedResult).toMatchObject({
        delegationTierChange: {
          tier: "small",
          before: stored,
          after: [candidate("gpt-5.3", 10), candidate("gpt-5.4", 30)],
        },
      });
      expect(yield* Ref.get(updates)).toBe(1);
    }),
);

it.effect("carries a stored candidate's options over a tier write that omits them", () => {
  const options = [{ id: "reasoningEffort", value: "high" }];
  return Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit;
    const service = yield* Settings.ServerSettingsService;
    const result = yield* finalResult(
      toolkit.handle("t3_environment_preferences_update", {
        setDelegationTier: { tier: "small", candidates: [tierCandidate(30)] },
      }),
    );
    expect(result?.encodedResult).toMatchObject({
      delegationTierChange: {
        after: [{ providerInstanceId: codexInstance, model: "gpt-5.4", options }],
      },
    });
    expect((yield* service.getSettings).delegationTiers.small).toEqual([
      { providerInstanceId: codexInstance, model: "gpt-5.4", options, minHeadroomPercent: 30 },
    ]);
  }).pipe(
    Effect.provide(
      environmentLayer(
        threadScope(),
        liveThreadShell(threadId),
        Settings.layerTest({
          delegationTiers: {
            small: [
              {
                providerInstanceId: codexInstance,
                model: "gpt-5.4",
                options,
                minHeadroomPercent: 20,
              },
            ],
            medium: [],
            large: [],
          },
        }),
        unlinkedCloud,
        [codexProvider()],
        [codexInstance],
      ),
    ),
  );
});

it.effect("pairs repeated tier candidates by position for options and headroom", () => {
  const high = [{ id: "reasoningEffort", value: "high" }];
  const low = [{ id: "reasoningEffort", value: "low" }];
  const entry = (minHeadroomPercent: number) => ({
    providerInstanceId: codexInstance,
    model: "gpt-5.4",
    minHeadroomPercent,
  });
  return Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit;
    const service = yield* Settings.ServerSettingsService;
    // An unguarded copy put first would win delegation over the guarded one.
    const undercut = yield* finalResult(
      toolkit.handle("t3_environment_preferences_update", {
        setDelegationTier: { tier: "small", candidates: [entry(0), entry(10)] },
      }),
    );
    expect(undercut?.result).toMatchObject({ code: "invalid_request" });
    yield* finalResult(
      toolkit.handle("t3_environment_preferences_update", {
        setDelegationTier: { tier: "small", candidates: [entry(10), entry(0)] },
      }),
    );
    expect((yield* service.getSettings).delegationTiers.small).toEqual([
      { ...entry(10), options: high },
      { ...entry(0), options: low },
    ]);
  }).pipe(
    Effect.provide(
      environmentLayer(
        threadScope(),
        liveThreadShell(threadId),
        Settings.layerTest({
          delegationTiers: {
            small: [
              { ...entry(10), options: high },
              { ...entry(0), options: low },
            ],
            medium: [],
            large: [],
          },
        }),
        unlinkedCloud,
        [codexProvider()],
        [codexInstance],
      ),
    ),
  );
});

it.effect("edits a stored tier candidate without its provider being available", () =>
  Effect.gen(function* () {
    const updates = yield* Ref.make(0);
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      return yield* finalResult(
        toolkit.handle("t3_environment_preferences_update", {
          setDelegationTier: { tier: "small", candidates: [tierCandidate(30)] },
        }),
      );
    }).pipe(
      Effect.provide(
        environmentLayer(
          threadScope(),
          liveThreadShell(threadId),
          countingSeededSettings(
            { delegationTiers: { small: [tierCandidate(20)], medium: [], large: [] } },
            updates,
          ),
          unlinkedCloud,
          [],
          [codexInstance],
        ),
      ),
    );
    expect(result?.encodedResult).toMatchObject({
      delegationTierChange: {
        tier: "small",
        before: [tierCandidate(20)],
        after: [tierCandidate(30)],
      },
    });
    expect(yield* Ref.get(updates)).toBe(1);
  }),
);

/** The pre-lock check and the in-lock write see different settings, as after a human edit. */
const shiftingSettings = (pre: Partial<ServerSettings>, during: Partial<ServerSettings>) =>
  Layer.mock(Settings.ServerSettingsService)({
    getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, ...pre }),
    modifySettings: (patch: (current: ServerSettings) => ServerSettingsPatch) => {
      const duringSettings = { ...DEFAULT_SERVER_SETTINGS, ...during };
      return Effect.succeed(applyServerSettingsPatch(duringSettings, patch(duringSettings)));
    },
  });

it.effect(
  "keeps delegationTierChange when only a raised runtime mode is dropped under the lock",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        return yield* finalResult(
          toolkit.handle("t3_environment_preferences_update", {
            defaultRuntimeMode: "auto",
            setDelegationTier: { tier: "small", candidates: [tierCandidate(40)] },
          }),
        );
      }).pipe(
        Effect.provide(
          environmentLayer(
            threadScope(),
            liveThreadShell(threadId),
            shiftingSettings(
              {
                defaultRuntimeMode: "full-access",
                delegationTiers: { small: [tierCandidate(30)], medium: [], large: [] },
              },
              {
                defaultRuntimeMode: "approval-required",
                delegationTiers: { small: [tierCandidate(30)], medium: [], large: [] },
              },
            ),
            unlinkedCloud,
            [codexProvider()],
            [codexInstance],
          ),
        ),
      );
      expect(result?.encodedResult).toMatchObject({
        defaultRuntimeMode: "approval-required",
        delegationTierChange: {
          tier: "small",
          before: [tierCandidate(30)],
          after: [tierCandidate(40)],
        },
      });
    }),
);

it.effect("refuses a tier write when the tier changed while it waited for the write lock", () =>
  Effect.gen(function* () {
    const run = (duringTier: ReturnType<typeof tierCandidate>[]) =>
      Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        return yield* finalResult(
          toolkit.handle("t3_environment_preferences_update", {
            setDelegationTier: { tier: "small", candidates: [tierCandidate(40)] },
          }),
        );
      }).pipe(
        Effect.provide(
          environmentLayer(
            threadScope(),
            liveThreadShell(threadId),
            shiftingSettings(
              { delegationTiers: { small: [tierCandidate(30)], medium: [], large: [] } },
              { delegationTiers: { small: duringTier, medium: [], large: [] } },
            ),
            unlinkedCloud,
            [codexProvider()],
            [codexInstance],
          ),
        ),
      );
    // Checks ran against the pre-lock tier, so any change meanwhile refuses.
    expect((yield* run([tierCandidate(20)]))?.result).toMatchObject({ code: "invalid_request" });
    expect((yield* run([tierCandidate(50)]))?.result).toMatchObject({ code: "invalid_request" });
    expect((yield* run([tierCandidate(30)]))?.encodedResult).toMatchObject({
      delegationTierChange: { before: [tierCandidate(30)], after: [tierCandidate(40)] },
    });
  }),
);

import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerSettingsPatch,
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

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

const dependencies = (
  getThreadShell: Effect.Effect<OrchestrationV2ThreadShell>,
  onUpdate: (patch: ServerSettingsPatch) => Effect.Effect<void>,
) =>
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
      getThreadShell: () => getThreadShell,
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
      updateSettings: (patch) => onUpdate(patch).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
    }),
  );

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = dependencies(
      Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      () => Ref.update(updates, (count) => count + 1),
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

it.effect("cannot change the agent library, whatever the patch names", () =>
  Effect.gen(function* () {
    const patches = yield* Ref.make<ReadonlyArray<ServerSettingsPatch>>([]);
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      yield* toolkit
        .handle("t3_environment_preferences_update", {
          newWorktreesStartFromOrigin: true,
          agentSkills: [],
          mcpGatewayProfiles: [],
          agentSkillDeletedAt: { review: "2027-01-01" },
        } as never)
        .pipe(Stream.unwrap, Stream.runCollect);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(
            dependencies(Effect.succeed(liveThreadShell(threadId)), (patch) =>
              Ref.update(patches, (seen) => [...seen, patch]),
            ),
          ),
        ),
      ),
    );
    const [patch] = yield* Ref.get(patches);
    expect(patch).toMatchObject({ newWorktreesStartFromOrigin: true });
    expect(patch).not.toHaveProperty("agentSkills");
    expect(patch).not.toHaveProperty("mcpGatewayProfiles");
    expect(patch).not.toHaveProperty("agentSkillDeletedAt");
  }),
);

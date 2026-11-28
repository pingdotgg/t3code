import { expect, it } from "@effect/vitest";
import {
  CALM_HOST_PRESSURE,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
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

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

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

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = layerEnvironment({
      getThreadShell: () =>
        Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      updateSettings: () =>
        Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
    });
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

it("keeps agent feedback out of the preferences agents read and write", () => {
  expect(
    EnvironmentHandlers.preferences({
      ...DEFAULT_SERVER_SETTINGS,
      agentFeedback: { mode: "auto" },
    }),
  ).not.toHaveProperty("agentFeedback");
  expect(
    Object.keys(EnvironmentToolkit.tools.t3_environment_preferences_update.parametersSchema.fields),
  ).not.toContain("agentFeedback");
});

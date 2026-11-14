import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type HostVolumeRole,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

const GiB = 1024 ** 3;

const volume = (
  mountPoint: string,
  freeGiB: number,
  totalGiB: number,
  roles: ReadonlyArray<HostVolumeRole> = [],
) => ({
  mountPoint,
  name: mountPoint,
  fileSystem: "ext4",
  availableBytes: Math.round(freeGiB * GiB),
  totalBytes: totalGiB * GiB,
  roles,
});

const dependencies = (options: {
  readonly getThreadShell: ThreadManagement.ThreadManagementService["Service"]["getThreadShell"];
  readonly updateSettings?: Settings.ServerSettingsService["Service"]["updateSettings"];
  readonly readMachine?: HostResources.HostResources["Service"]["readMachine"];
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
      getThreadShell: options.getThreadShell,
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
    Layer.mock(HostResources.HostResources)(
      options.readMachine ? { readMachine: options.readMachine } : {},
    ),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      ...(options.updateSettings ? { updateSettings: options.updateSettings } : {}),
    }),
  );

const withHandlers = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layerDependencies: ReturnType<typeof dependencies>,
) =>
  effect.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
        Layer.provideMerge(layerDependencies),
      ),
    ),
  );

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = dependencies({
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
    }).pipe((effect) => withHandlers(effect, layerDependencies));
  }),
);

it.effect("reads the machine's resources rounded, with T3's volumes first", () =>
  Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit;
    const result = yield* toolkit
      .handle("t3_environment_read", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    const read = result.at(-1)?.result;
    // toEqual: absent swap, disk reason and iGPU memory must stay out of the result.
    expect(read !== undefined && "machine" in read ? read.machine : read).toEqual({
      cpu: { usedPercent: 37, cores: 16, model: "Acme M9", load1m: 6.1 },
      memory: { availableGiB: 12.5, totalGiB: 64 },
      disks: [
        { mount: "/home", freeGiB: 40, totalGiB: 500, holds: ["t3Home", "worktrees"] },
        { mount: "/", freeGiB: 2.3, totalGiB: 100 },
        ...[2, 3, 4, 5].map((n) => ({ mount: `/v${n}`, freeGiB: 1, totalGiB: 1 })),
      ],
      gpus: [
        { name: "Acme RTX", usedPercent: 90, memoryFreeGiB: 4, memoryTotalGiB: 24 },
        { name: "Acme iGPU" },
      ],
    });
  }).pipe((effect) =>
    withHandlers(
      effect,
      dependencies({
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        readMachine: Effect.succeed({
          sampledAt: 1_700_000_000_000,
          cpuUtilization: 0.3712,
          cpuCount: 16,
          cpuModel: "Acme M9",
          loadAverage: { one: 6.08, five: 5, fifteen: 4 },
          availableMemoryBytes: 12.49 * GiB,
          totalMemoryBytes: 64 * GiB,
          swap: { totalBytes: 0, usedBytes: 0 },
          storage: {
            sampledAt: 1_700_000_000_000,
            volumes: [
              volume("/home", 40, 500, ["t3Home", "worktrees"]),
              volume("/", 2.31, 100),
              ...[2, 3, 4, 5, 6].map((n) => volume(`/v${n}`, 1, 1)),
            ],
          },
          gpu: {
            gpus: [
              {
                name: "Acme RTX",
                utilization: 0.9,
                memoryTotalBytes: 24 * GiB,
                memoryUsedBytes: 20 * GiB,
              },
              { name: "Acme iGPU" },
            ],
          },
        }),
      }),
    ),
  ),
);

it("decodes a linked environment's read that predates machine resources", () => {
  const decode = Schema.decodeUnknownSync(
    EnvironmentToolkit.tools.t3_environment_read.successSchema,
  );
  const identity = {
    environmentId,
    label: "Test",
    serverVersion: "0.0.0",
    platform: { os: "linux", arch: "x64" },
    preferences: EnvironmentHandlers.preferences(DEFAULT_SERVER_SETTINGS),
  };
  expect(decode(identity)).not.toHaveProperty("machine");
});

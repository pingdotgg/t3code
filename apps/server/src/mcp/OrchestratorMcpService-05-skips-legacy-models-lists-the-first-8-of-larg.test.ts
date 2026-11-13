import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EnvironmentId,
  GitCommandError,
  MessageId,
  NodeId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  type OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpTarget,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
  ScheduledTaskId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import {
  OrchestratorProjectionError,
  OrchestratorThreadAboveModeLimitError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { resolveRuntimeMode } from "./delegatedTaskModes.ts";
import type { ProjectionRecordFilter } from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import {
  decodeTarget,
  layerOrchestratorService,
} from "./OrchestratorMcpService-fixtures.testkit.ts";

describe("OrchestratorMcpService provider resolution", () => {
  const parentThreadId = ThreadId.make("thread:mcp-providers-parent");

  const parentRunId = RunId.make("run:mcp-providers-parent");

  const parentNodeId = NodeId.make("node:mcp-providers-root");

  const projectId = ProjectId.make("project:mcp-providers");

  const codexInstanceId = ProviderInstanceId.make("codex");

  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-providers"),
    requestNamespace: "provider-session:mcp-providers",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-providers",
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const providerSnapshot = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly model?: string;
    readonly enabled?: boolean;
  }): ServerProvider => ({
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: input.enabled !== false,
    version: input.enabled === false ? null : "test",
    status: input.enabled === false ? "disabled" : "ready",
    auth: { status: input.enabled === false ? "unknown" : "authenticated" },
    ...(input.enabled === false ? { message: "Provider is disabled in T3 Code settings." } : {}),
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  const providerRegistryLayer = (providers: ReadonlyArray<ServerProvider>) =>
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    });

  const adapterRegistryLayer = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(instanceIds),
        get: (instanceId) =>
          instanceIds.includes(instanceId)
            ? Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
            : Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              ),
      }),
    );

  const parentProjection = (
    subagents: ReadonlyArray<unknown>,
    modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
    } = { instanceId: codexInstanceId, model: "gpt-5.4" },
  ): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        projectId,
        title: "MCP parent",
        createdBy: "user",
        creationSource: "web",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      runs: [
        {
          id: parentRunId,
          ordinal: 1,
          status: "running",
          rootNodeId: parentNodeId,
          providerInstanceId: codexInstanceId,
          modelSelection,
        },
      ],
      contextTransfers: [],
      subagents,
    }) as unknown as OrchestrationV2ThreadProjection;

  describe("listed models", () => {
    const opencodeInstanceId = ProviderInstanceId.make("opencode");
    const model = (slug: string, extra: Partial<ServerProvider["models"][number]> = {}) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
      ...extra,
    });
    const opencodeSlugs = Array.from(
      { length: 12 },
      (_, index) => `oc/m${String(index + 1).padStart(2, "0")}`,
    );
    const catalog: ReadonlyArray<ServerProvider> = [
      {
        ...providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
        }),
        displayName: "Codex",
        models: [
          model("gpt-6", {
            name: "Sol",
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  label: "Reasoning",
                  description: "How hard the model thinks.",
                  type: "select",
                  options: [
                    { id: "low", label: "Low", description: "Fast." },
                    { id: "high", label: "High", isDefault: true },
                  ],
                  promptInjectedValues: ["high"],
                },
                { id: "fastMode", label: "Fast", type: "boolean" },
                {
                  id: "agent",
                  label: "Agent",
                  type: "select",
                  options: [{ id: "build", label: "Build" }],
                  currentValue: "build",
                },
              ],
            },
          }),
          model("gpt-5", { name: "Code Legacy", isLegacy: true }),
          model("gpt-4", { isLegacy: true }),
          model("gpt-3", { name: "GPT-3", isLegacy: true }),
          model("my-alpha", { isCustom: true }),
        ],
      },
      {
        ...providerSnapshot({
          instanceId: opencodeInstanceId,
          driver: ProviderDriverKind.make("opencode"),
        }),
        models: [
          ...opencodeSlugs.map((slug) => model(slug, { isLegacy: slug === "oc/m03" })),
          model("oc-custom", { isCustom: true }),
        ],
      },
    ];

    const capabilitiesWith = (search?: string) =>
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.capabilities(scope, search === undefined ? {} : { search });
      }).pipe(
        Effect.provide(
          layerOrchestratorService.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                NodeCrypto.layer,
                Layer.mock(ThreadManagementService.ThreadManagementService)({
                  getThreadRecords: () =>
                    Effect.succeed(
                      parentProjection([], { instanceId: codexInstanceId, model: "gpt-3" }),
                    ),
                }),
                ServerSettings.layerTest({
                  favorites: [
                    { provider: codexInstanceId, model: "gpt-4" },
                    { provider: opencodeInstanceId, model: "oc/m10" },
                  ],
                  providerModelPreferences: {
                    [opencodeInstanceId]: { hiddenModels: ["oc/m02"], modelOrder: ["oc/m12"] },
                  },
                }),
                providerRegistryLayer(catalog),
                adapterRegistryLayer([codexInstanceId, opencodeInstanceId]),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(RemoteDelegation.RemoteDelegation)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              ),
            ),
          ),
        ),
      );

    const listing = (capabilities: OrchestratorMcpCapabilitiesResult) =>
      capabilities.providers.map((provider) => ({
        id: provider.providerInstanceId,
        models: provider.models.map((entry) => entry.id),
        omitted: provider.omittedModels ?? 0,
      }));

    it.effect(
      "skips legacy models, lists the first 8 of large catalogs, and keeps pinned models",
      () =>
        Effect.gen(function* () {
          assert.deepEqual(listing(yield* capabilitiesWith()), [
            // gpt-4 is a favorite and gpt-3 is the caller's model; legacy gpt-5 is left out.
            { id: codexInstanceId, models: ["gpt-6", "gpt-4", "gpt-3", "my-alpha"], omitted: 1 },
            {
              id: opencodeInstanceId,
              models: [
                "oc/m12",
                "oc/m01",
                "oc/m04",
                "oc/m05",
                "oc/m06",
                "oc/m07",
                "oc/m08",
                "oc/m09",
                "oc/m10",
                "oc-custom",
              ],
              omitted: 2,
            },
          ]);
        }),
    );

    it.effect("search matches every word and caps each provider's matches", () =>
      Effect.gen(function* () {
        assert.deepEqual(listing(yield* capabilitiesWith("GPT 5")), [
          { id: codexInstanceId, models: ["gpt-5"], omitted: 0 },
          { id: opencodeInstanceId, models: [], omitted: 0 },
        ]);
        const opencode = listing(yield* capabilitiesWith("oc/m"))[1];
        assert.deepEqual(opencode, {
          id: opencodeInstanceId,
          models: ["oc/m12", "oc/m01", "oc/m03", "oc/m04", "oc/m05", "oc/m06", "oc/m07", "oc/m08"],
          omitted: 3,
        });
        // A word naming the provider matches all its models, so legacy ones stay out.
        assert.deepEqual(listing(yield* capabilitiesWith("Codex")), [
          { id: codexInstanceId, models: ["gpt-6", "gpt-4", "gpt-3", "my-alpha"], omitted: 1 },
          { id: opencodeInstanceId, models: [], omitted: 0 },
        ]);
        assert.deepEqual(listing(yield* capabilitiesWith(" ")), listing(yield* capabilitiesWith()));
        for (const search of ["code", "codex code", "  CODE  "]) {
          assert.deepEqual(listing(yield* capabilitiesWith(search))[0], {
            id: codexInstanceId,
            models: ["gpt-5"],
            omitted: 0,
          });
        }
        assert.deepEqual(
          listing(yield* capabilitiesWith("open"))[1],
          listing(yield* capabilitiesWith())[1],
        );
        assert.deepEqual(listing(yield* capabilitiesWith("codex gpt 5"))[0], {
          id: codexInstanceId,
          models: ["gpt-5"],
          omitted: 0,
        });
      }),
    );

    it.effect("describes models by id, distinct label, and option values", () =>
      Effect.gen(function* () {
        const codex = (yield* capabilitiesWith()).providers[0];
        assert.deepEqual(codex?.models.slice(0, 4), [
          {
            id: "gpt-6",
            label: "Sol",
            options: [
              { id: "effort", values: ["low", "high"], default: "high" },
              { id: "fastMode", values: [false, true] },
              { id: "agent", values: ["build"], default: "build" },
            ],
          },
          { id: "gpt-4" },
          { id: "gpt-3" },
          { id: "my-alpha" },
        ]);
      }),
    );
  });

  it.effect("rejects delegation to a provider without a registered adapter", () =>
    Effect.gen(function* () {
      const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
      const forkShadow = yield* buildUnavailableProviderSnapshot({
        driverKind: "forkOnly",
        instanceId: forkOnlyInstanceId,
        reason: "Driver 'forkOnly' is not registered in this build.",
        checkedAt: "2026-09-13T00:00:00.000Z",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          forkShadow,
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const byInstance = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: forkOnlyInstanceId },
            mode: "async",
            clientRequestId: "delegate-fork-1",
          })
          .pipe(Effect.flip);
        assert.equal(byInstance.code, "provider_unavailable");
        assert.isTrue(byInstance.message.includes("No V2 provider adapter is registered."));

        const byDriver = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("forkOnly") },
            mode: "async",
            clientRequestId: "delegate-fork-2",
          })
          .pipe(Effect.flip);
        assert.equal(byDriver.code, "provider_unavailable");
        assert.isTrue(
          byDriver.message.includes("No V2 provider adapter is registered for driver forkOnly."),
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );
});

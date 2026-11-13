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

  const childThreadId = ThreadId.make("thread:mcp-providers-child");

  const parentRunId = RunId.make("run:mcp-providers-parent");

  const parentNodeId = NodeId.make("node:mcp-providers-root");

  const taskId = NodeId.make("node:mcp-providers-task");

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

  const childProjection = {
    thread: { id: childThreadId, title: "Child" },
    runs: [],
    contextTransfers: [],
    messages: [],
    subagents: [],
    providerThreads: [],
    runtimeRequests: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;

  it.effect(
    "inherits delegated options, merges overrides, and resets on explicit clearing or a new target",
    () =>
      Effect.gen(function* () {
        const peerId = ProviderInstanceId.make("codex-subscription-2");
        const driver = ProviderDriverKind.make("codex");
        const inherited = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ],
        } as const;
        const override = [{ id: "reasoningEffort", value: "max" }] as const;
        const cases = [
          {
            name: "partial override",
            target: { options: override },
            expected: { ...inherited, options: [...override, inherited.options[1]] },
          },
          {
            name: "clear with array",
            target: { options: [] },
            expected: { ...inherited, options: [] },
          },
          {
            name: "clear with object",
            target: { options: {} },
            expected: { ...inherited, options: [] },
          },
          {
            name: "change model",
            target: { model: "other-model" },
            expected: { instanceId: codexInstanceId, model: "other-model" },
          },
          {
            name: "change provider with override",
            target: { providerInstanceId: peerId, options: { reasoningEffort: "max" } },
            expected: { instanceId: peerId, model: inherited.model, options: override },
          },
        ] as const;
        for (const testCase of cases) {
          const commands: Array<unknown> = [];
          const task = {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            providerInstanceId: testCase.expected.instanceId,
            model: testCase.expected.model,
            status: "running",
            result: null,
          };
          const dependencies = Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              assertProviderInstanceEnabled: () => Effect.void,
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(commands.length > 0 ? [task] : [], inherited)
                    : childProjection,
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return {
                    sequence: 1,
                    storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
                  } as never;
                }),
            }),
            ServerSettings.layerTest(),
            providerRegistryLayer([
              {
                ...providerSnapshot({
                  instanceId: codexInstanceId,
                  driver,
                  model: inherited.model,
                }),
                models: [inherited.model, "other-model"].map((model) => ({
                  slug: model,
                  name: model,
                  isCustom: false,
                  capabilities: null,
                })),
              },
              providerSnapshot({ instanceId: peerId, driver, model: inherited.model }),
            ]),
            adapterRegistryLayer([codexInstanceId, peerId]),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const capabilities = yield* service.capabilities(scope);
            assert.deepEqual(capabilities.inheritedOptions, inherited.options);
            yield* service.delegateTask(scope, {
              task: "Review the change.",
              target: yield* decodeTarget(testCase.target),
              mode: "async",
              clientRequestId: testCase.name,
            });
            assert.deepEqual(
              (commands[0] as { modelSelection: unknown }).modelSelection,
              testCase.expected,
              testCase.name,
            );
          }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
        }
      }),
  );

  it.effect("accepts the inherited options it reports back as a delegate target", () =>
    Effect.gen(function* () {
      // t3_thread_launch keeps a model selection as given, so a thread can hold an option its model lacks.
      const inherited = {
        instanceId: codexInstanceId,
        model: "gpt-5.4",
        options: [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: false },
        ],
      } as const;
      const commands: Array<{ readonly modelSelection?: unknown }> = [];
      const task = {
        id: taskId,
        threadId: parentThreadId,
        origin: "app_owned",
        childThreadId,
        providerInstanceId: codexInstanceId,
        model: inherited.model,
        status: "running",
        result: null,
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(commands.length > 0 ? [task] : [], inherited)
                : childProjection,
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command as { readonly modelSelection?: unknown });
              return {
                sequence: 1,
                storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
              } as never;
            }),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          {
            ...providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
            }),
            models: [
              {
                slug: inherited.model,
                name: inherited.model,
                isCustom: false,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "reasoningEffort",
                      label: "Reasoning",
                      type: "select",
                      options: [{ id: "low", label: "Low" }],
                    },
                  ],
                },
              },
            ],
          },
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const { inheritedOptions } = yield* service.capabilities(scope);
        yield* service.delegateTask(scope, {
          task: "Review the change.",
          target: yield* decodeTarget({ options: inheritedOptions }),
          mode: "async",
        });
        assert.deepEqual(commands[0]?.modelSelection, {
          ...inherited,
          options: [inherited.options[0]],
        });
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  describe("resolveRuntimeMode", () => {
    const muse = {
      modelSelection: { instanceId: ProviderInstanceId.make("muse"), model: "muse-model" },
      supportedRuntimeModes: ["approval-required", "full-access"] as const,
    };

    it.effect("refuses an explicit mode the target provider does not offer", () =>
      Effect.gen(function* () {
        const error = yield* resolveRuntimeMode("full-access", "auto-accept-edits", muse).pipe(
          Effect.flip,
        );
        assert.equal(error.code, "invalid_request");
        assert.include(error.message, "approval-required, full-access");
      }),
    );

    it.effect("steps an inherited mode down to the broadest one the provider offers", () =>
      Effect.gen(function* () {
        assert.equal(yield* resolveRuntimeMode("full-access", "inherit", muse), "full-access");
        assert.equal(yield* resolveRuntimeMode("auto", undefined, muse), "approval-required");
      }),
    );
  });
});

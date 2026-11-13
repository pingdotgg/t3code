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

  const antigravityInstanceId = ProviderInstanceId.make("antigravity");

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

  it.effect.each([
    "parent completion",
    "nested child completion",
    "child run completion",
    "child question",
    "child approval",
  ] as const)("a task wait still returns on %s", (wake) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      const subscribed = yield* Deferred.make<void>();
      const nestedId = NodeId.make("node:mcp-wait-nested");
      const childRunId = RunId.make("run:mcp-wait-child");
      const childRootId = NodeId.make("node:mcp-wait-child-root");
      const eventThreadId = wake === "parent completion" ? parentThreadId : childThreadId;
      const eventType =
        wake === "child run completion"
          ? "run.updated"
          : wake === "child question" || wake === "child approval"
            ? "runtime-request.updated"
            : "subagent.updated";
      const terminal = wake.endsWith("completion");
      let ready = false;
      const task = () => ({
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        providerInstanceId: codexInstanceId,
        driver: "codex",
        childThreadId,
        model: "gpt-5.4",
        status: ready && terminal ? "completed" : "running",
        result: ready && wake === "parent completion" ? "done" : null,
      });
      const child = () =>
        ({
          ...childProjection,
          runs: [
            {
              id: childRunId,
              ordinal: 1,
              status:
                wake === "nested child completion" || (ready && terminal) ? "completed" : "running",
              startedAt: DateTime.makeUnsafe(0),
              completedAt: ready && terminal ? DateTime.makeUnsafe(1) : null,
            },
          ],
          subagents:
            wake === "nested child completion"
              ? [{ id: nestedId, status: ready ? "completed" : "running" }]
              : [],
          nodes: [{ id: childRootId, runId: childRunId }],
          runtimeRequests:
            ready && !terminal
              ? [
                  {
                    id: "request:mcp-wait-answer",
                    nodeId: childRootId,
                    kind: wake === "child question" ? "user_input" : "command",
                    status: "pending",
                    responseCapability: { type: "live" },
                    createdAt: DateTime.makeUnsafe(0),
                  },
                ]
              : [],
        }) as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Effect.sync(() => (threadId === parentThreadId ? parentProjection([task()]) : child())),
          getThreadEventSequence: () => Effect.succeed(0),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: (input) =>
            input?.threadId === eventThreadId && input.eventType === eventType
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          dispatch: () =>
            Effect.succeed({
              sequence: 1,
              storedEvents: [{ event: { type: "subagent.updated", payload: task() } }],
            } as never),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const waiting = yield* service
          .delegateTask(scope, { task: "Review the change.", mode: "wait" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(subscribed);
        ready = true;
        if (wake === "parent completion") {
          yield* Queue.offer(events, {
            sequence: 2,
            event: {
              type: "subagent.updated",
              threadId: parentThreadId,
              payload: { ...task(), id: nestedId },
            },
          } as unknown as OrchestrationV2StoredEvent);
        }
        yield* Queue.offer(events, {
          sequence: 3,
          event: {
            type: eventType,
            threadId: eventThreadId,
            payload: { id: wake === "parent completion" ? taskId : nestedId },
          },
        } as unknown as OrchestrationV2StoredEvent);
        const result = yield* Fiber.join(waiting);
        assert.isFalse(result.waitTimedOut);
        if (terminal) {
          assert.equal(result.status, "completed");
          if (wake === "parent completion") assert.equal(result.summary, "done");
        } else {
          assert.equal(result.status, "running");
          if (wake === "child question") assert.isTrue(result.hasPendingQuestion);
          else {
            assert.deepEqual(result.pendingApproval, {
              requestId: "request:mcp-wait-answer",
              kind: "command",
              runId: childRunId,
            });
          }
        }
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect(
    "advertises orchestration capability from registered adapters rather than a driver allowlist",
    () =>
      Effect.gen(function* () {
        const disabledAntigravityInstanceId = ProviderInstanceId.make("antigravity-alt");
        const disabledWithoutAdapterInstanceId = ProviderInstanceId.make("codex-without-adapter");
        const projectDisabledInstanceId = ProviderInstanceId.make("codex-project-off");
        const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
        const forkShadow = yield* buildUnavailableProviderSnapshot({
          driverKind: "forkOnly",
          instanceId: forkOnlyInstanceId,
          reason: "Driver 'forkOnly' is not registered in this build.",
          checkedAt: "2026-09-13T00:00:00.000Z",
        });
        let providers: ReadonlyArray<ServerProvider> = [
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("pi"),
            driver: ProviderDriverKind.make("pi"),
            model: "pi-model",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("acpRegistry"),
            driver: ProviderDriverKind.make("acpRegistry"),
            model: "acp-model",
          }),
          providerSnapshot({
            instanceId: antigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
          }),
          providerSnapshot({
            instanceId: disabledAntigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
            enabled: false,
          }),
          providerSnapshot({
            instanceId: disabledWithoutAdapterInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
            enabled: false,
          }),
          providerSnapshot({
            instanceId: projectDisabledInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          forkShadow,
        ];
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(parentProjection([])),
          }),
          ServerSettings.layerTest({
            providerInstances: {
              [ProviderInstanceId.make("pi")]: {
                driver: ProviderDriverKind.make("pi"),
                enabled: true,
              },
              [ProviderInstanceId.make("acpRegistry")]: {
                driver: ProviderDriverKind.make("acpRegistry"),
                enabled: true,
              },
              [antigravityInstanceId]: {
                driver: ProviderDriverKind.make("antigravity"),
                enabled: true,
              },
              [projectDisabledInstanceId]: { driver: ProviderDriverKind.make("codex") },
            },
            projectSettingsOverrides: {
              [projectId]: {
                providerInstances: { [projectDisabledInstanceId]: { enabled: false } },
              },
            },
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(() => providers),
          }),
          adapterRegistryLayer([
            codexInstanceId,
            projectDisabledInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
            disabledAntigravityInstanceId,
          ]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const capabilities = yield* service.capabilities(scope);
          const byId = new Map(
            capabilities.providers.map((provider) => [provider.providerInstanceId, provider]),
          );
          for (const provider of providers) {
            assert.deepEqual(
              byId.get(provider.instanceId)?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          providers = providers.map((provider) => ({
            ...provider,
            models: [
              ...provider.models,
              {
                slug: `${provider.driver}/custom-model-after-refresh`,
                name: "Custom model",
                isCustom: true,
                capabilities: null,
              },
            ],
          }));
          const refreshed = yield* service.capabilities(scope);
          for (const provider of providers) {
            assert.deepEqual(
              refreshed.providers
                .find((entry) => entry.providerInstanceId === provider.instanceId)
                ?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          for (const instanceId of [
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
          ]) {
            const entry = byId.get(instanceId);
            assert.isDefined(entry);
            assert.isTrue(
              entry!.canRunChildTask,
              `expected ${instanceId} to advertise canRunChildTask`,
            );
            assert.isTrue(entry!.canRunCrossProviderChildTask);
            assert.deepEqual(entry!.constraints, []);
          }

          const disabled = byId.get(disabledAntigravityInstanceId);
          assert.isDefined(disabled);
          assert.isFalse(disabled!.canRunChildTask);
          assert.isFalse(disabled!.canRunCrossProviderChildTask);
          assert.deepEqual(disabled!.constraints, ["Provider instance is disabled."]);

          const projectDisabled = byId.get(projectDisabledInstanceId);
          assert.isDefined(projectDisabled);
          assert.isFalse(projectDisabled!.canRunChildTask);
          assert.deepEqual(projectDisabled!.constraints, ["Provider instance is disabled."]);

          const disabledWithoutAdapter = byId.get(disabledWithoutAdapterInstanceId);
          assert.isDefined(disabledWithoutAdapter);
          assert.isFalse(disabledWithoutAdapter!.canRunChildTask);
          assert.isFalse(disabledWithoutAdapter!.canRunCrossProviderChildTask);
          assert.deepEqual(disabledWithoutAdapter!.constraints, [
            "No V2 provider adapter is registered.",
            "Provider instance is disabled.",
          ]);

          const fork = byId.get(forkOnlyInstanceId);
          assert.isDefined(fork);
          assert.isFalse(fork!.canRunChildTask);
          assert.isFalse(fork!.canRunCrossProviderChildTask);
          assert.deepEqual(fork!.constraints, [
            "No V2 provider adapter is registered.",
            "Driver 'forkOnly' is not registered in this build.",
            "Provider instance is disabled.",
          ]);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );
});

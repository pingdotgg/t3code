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

  it.effect("driver-only delegation skips an instance the project turned off", () =>
    Effect.gen(function* () {
      const altInstanceId = ProviderInstanceId.make("codex-alt");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: altInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [])
                : childProjection,
            ),
          isProviderInstanceEnabledForProject: ({ instanceId }) =>
            Effect.succeed(instanceId !== codexInstanceId),
          assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
            instanceId === codexInstanceId
              ? Effect.fail(
                  new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                    projectId,
                    instanceId,
                  }),
                )
              : Effect.void,
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: altInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId, altInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("codex") },
          mode: "async",
          clientRequestId: "delegate-driver-skip-disabled-1",
        });
        assert.equal(result.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        const request = commands[0] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(request.modelSelection.instanceId, altInstanceId);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "retrying an accepted driver-only delegation replays even after the project disables every candidate",
    () =>
      Effect.gen(function* () {
        const altInstanceId = ProviderInstanceId.make("codex-alt");
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const accepted = yield* Ref.make(false);
        const everyCandidateDisabled = yield* Ref.make(false);
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Ref.get(accepted).pipe(
                Effect.map((isAccepted) =>
                  threadId === parentThreadId
                    ? parentProjection(isAccepted ? [task] : [])
                    : childProjection,
                ),
              ),
            hasReceipt: () => Ref.get(accepted),
            isProviderInstanceEnabledForProject: () =>
              Ref.get(everyCandidateDisabled).pipe(Effect.map((disabled) => !disabled)),
            assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
              Effect.all([Ref.get(accepted), Ref.get(everyCandidateDisabled)]).pipe(
                Effect.flatMap(([isAccepted, disabled]) =>
                  isAccepted || !disabled
                    ? Effect.void
                    : Effect.fail(
                        new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                          projectId,
                          instanceId,
                        }),
                      ),
                ),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(Ref.set(accepted, true)),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: altInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId, altInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          ServerSettings.layerTest(),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const first = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("codex") },
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.equal(first.status, "running");

          yield* Ref.set(everyCandidateDisabled, true);

          const retry = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("codex") },
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.equal(retry.status, "running");

          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 2);
          const retryCommand = commands[1] as {
            modelSelection: { instanceId: string; model: string };
          };
          assert.equal(retryCommand.modelSelection.instanceId, codexInstanceId);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );
});

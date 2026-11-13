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

  describe("scheduled tasks at modes above the caller's", () => {
    const projectId = ProjectId.make("project:scheduled");
    const boundThreadId = ThreadId.make("thread:scheduled-bound");
    const task = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
      id: ScheduledTaskId.make("scheduled-task:webhook"),
      title: "On push",
      prompt: "Do {{body.instruction}}",
      enabled: true,
      schedule: { type: "webhook", signature: null },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
      webhook: {
        path: "/hooks/scheduled-task/secret",
        url: "https://t3.example/hooks/secret",
        hasSecret: false,
      },
      ...overrides,
    });
    const supervisedClient: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled"),
      requestNamespace: "client:scheduled",
      thread: undefined,
      client: {
        sessionId: "scheduled",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      tasks: ReadonlyArray<ScheduledTask>,
      boundThread: OrchestrationV2ThreadShell | null,
      upserted: Ref.Ref<number>,
    ) =>
      layerOrchestratorService.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) =>
                Effect.succeed(threadId === boundThreadId ? boundThread : null),
            }),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks }),
              upsert: () =>
                Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: tasks[0]! })),
            }),
          ),
        ),
      );

    it.effect("hides a webhook URL from a caller below the task's modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) => mcp.listScheduledTasks(supervisedClient, { projectId })),
          Effect.provide(
            service(
              [
                task({ runtimeMode: "full-access" }),
                task({ id: ScheduledTaskId.make("scheduled-task:supervised") }),
              ],
              null,
              upserted,
            ),
          ),
        );
        assert.deepEqual(
          listed.tasks.map((summary) => summary.webhookUrl),
          [undefined, "https://t3.example/hooks/secret"],
        );
      }),
    );

    it.effect("hides a webhook URL from a thread whose turn has ended", () =>
      Effect.gen(function* () {
        const callerId = ThreadId.make("thread:scheduled-ended");
        const shell = liveThreadShell(callerId, { activeRunId: null });
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                requestNamespace: "provider:scheduled-ended",
                thread: {
                  threadId: callerId,
                  providerSessionId: "provider:scheduled-ended",
                  providerInstanceId: shell.providerInstanceId,
                },
                client: undefined,
              },
              { projectId },
            ),
          ),
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  NodeCrypto.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: () => Effect.succeed(null),
                    getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [task({})] }),
                  }),
                ),
              ),
            ),
          ),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("never shows a read-only client a webhook URL", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                client: { sessionId: "scheduled", label: "Claude Code", access: "read-only" },
              },
              { projectId },
            ),
          ),
          Effect.provide(service([task({})], null, upserted)),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("checks a bound task against its thread's current modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId });
        const layer = service(
          [bound],
          liveThreadShell(boundThreadId, { runtimeMode: "full-access" }),
          upserted,
        );
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(layer),
        );
        const listed = yield* mcp.listScheduledTasks(supervisedClient, { projectId });
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
        const error = yield* mcp
          .updateScheduledTask(supervisedClient, {
            scheduledTaskId: bound.id,
            prompt: "Something else",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.equal(yield* Ref.get(upserted), 0);
      }),
    );

    it.effect("reports a saved task even when its bound thread cannot be read", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId });
        const lookups = yield* Ref.make(0);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  NodeCrypto.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: (threadId) =>
                      Ref.getAndUpdate(lookups, (count) => count + 1).pipe(
                        Effect.flatMap((count) =>
                          count === 0
                            ? Effect.succeed(
                                liveThreadShell(threadId, { runtimeMode: "approval-required" }),
                              )
                            : Effect.fail(new OrchestratorProjectionError({ threadId })),
                        ),
                      ),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [bound] }),
                    upsert: () =>
                      Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: bound })),
                  }),
                ),
              ),
            ),
          ),
        );
        const updated = yield* mcp.updateScheduledTask(supervisedClient, {
          scheduledTaskId: bound.id,
          prompt: "Something else",
        });
        assert.equal(yield* Ref.get(upserted), 1);
        assert.equal(updated.scheduledTaskId, bound.id);
        assert.equal(updated.webhookUrl, undefined);
      }),
    );
  });

  describe("the base branch of an unbound scheduled task", () => {
    const projectId = ProjectId.make("project:scheduled-base");
    const workspaceRoot = "/repo/scheduled-base";
    const existing: ScheduledTask = {
      id: ScheduledTaskId.make("scheduled-task:base"),
      title: "Nightly",
      prompt: "Check the build",
      enabled: true,
      schedule: { type: "interval", everyMs: 3_600_000 },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    };
    const client: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled-base"),
      requestNamespace: "client:scheduled-base",
      thread: undefined,
      client: {
        sessionId: "scheduled-base",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      git: Partial<GitVcsDriver.GitVcsDriver["Service"]>,
      saved: Ref.Ref<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>,
    ) =>
      OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeedSome({
                  id: projectId,
                  workspaceRoot,
                  defaultModelSelection: existing.modelSelection,
                } as never),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks: [existing] }),
              upsert: (input) =>
                Ref.update(saved, (strategies) => [...strategies, input.workspaceStrategy]).pipe(
                  Effect.as({ task: existing }),
                ),
            }),
          ),
        ),
      );
    const masterRepository: Partial<GitVcsDriver.GitVcsDriver["Service"]> = {
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: (cwd, remoteName) =>
        Effect.succeed(cwd === workspaceRoot && remoteName === "origin" ? "master" : null),
      resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
    };
    const schedule = { type: "interval", everyMs: 3_600_000 } as const;

    it.effect("starts from the project's default branch", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(service(masterRepository, saved)),
        );
        yield* mcp.scheduleTask(client, { projectId, prompt: "Check the build", schedule });
        assert.deepEqual(yield* Ref.get(saved), [
          { type: "worktree", baseRef: "origin/master", startFromOrigin: true },
        ]);
      }),
    );

    it.effect("follows the default branch when a task is unbound from its thread", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(service(masterRepository, saved)),
        );
        yield* mcp.updateScheduledTask(client, {
          scheduledTaskId: existing.id,
          bindToCurrentThread: false,
        });
        assert.deepEqual(yield* Ref.get(saved), [
          { type: "worktree", baseRef: "origin/master", startFromOrigin: true },
        ]);
      }),
    );

    it.effect.each([
      {
        name: "no remote, only master",
        remote: null,
        remoteDefault: null,
        refs: ["refs/heads/master"],
        baseRef: "master",
      },
      {
        name: "no remote, main and master",
        remote: null,
        remoteDefault: null,
        refs: ["refs/heads/master", "refs/heads/main"],
        baseRef: "main",
      },
      {
        name: "no remote, neither main nor master",
        remote: null,
        remoteDefault: null,
        refs: ["refs/heads/develop"],
        baseRef: "main",
      },
      {
        name: "no recorded HEAD, remote main and a stale local master",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/master", "refs/remotes/origin/main"],
        baseRef: "origin/main",
      },
      {
        name: "no recorded HEAD, master only on the remote",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/remotes/origin/master"],
        baseRef: "origin/master",
      },
      {
        name: "no recorded HEAD, local main and master only on the remote",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/main", "refs/remotes/origin/master"],
        baseRef: "origin/master",
      },
      {
        name: "no recorded HEAD, nothing conventional on the remote, local main",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/main", "refs/remotes/origin/develop"],
        baseRef: "main",
      },
      {
        name: "a recorded HEAD whose branch is gone",
        remote: "origin",
        remoteDefault: "main",
        refs: ["refs/heads/main", "refs/remotes/origin/master"],
        baseRef: "origin/master",
      },
      {
        name: "a remote not called origin",
        remote: "upstream",
        remoteDefault: "develop",
        refs: ["refs/remotes/upstream/develop"],
        baseRef: "upstream/develop",
      },
      {
        name: "a remote not called origin, no recorded HEAD",
        remote: "upstream",
        remoteDefault: null,
        refs: ["refs/remotes/upstream/main"],
        baseRef: "upstream/main",
      },
    ])("$name starts from $baseRef", ({ remote, remoteDefault, refs, baseRef }) =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const gitFailure = (cwd: string, detail: string) =>
          new GitCommandError({ operation: "GitVcsDriver.test", command: "git", cwd, detail });
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(
              {
                resolvePrimaryRemoteName: (cwd) =>
                  remote === null
                    ? Effect.fail(gitFailure(cwd, "No git remote is configured."))
                    : Effect.succeed(remote),
                resolveDefaultBranchName: () => Effect.succeed(remoteDefault),
                resolveCommit: ({ cwd, revision }) =>
                  refs.includes(revision)
                    ? Effect.succeed({ commitSha: "abc123" })
                    : Effect.fail(gitFailure(cwd, "Needed a single revision")),
              },
              saved,
            ),
          ),
        );
        yield* mcp.scheduleTask(client, { projectId, prompt: "Check the build", schedule });
        assert.deepEqual(yield* Ref.get(saved), [
          { type: "worktree", baseRef, startFromOrigin: true },
        ]);
      }),
    );
  });

  it.effect(
    "reports the child run's selection after a restart and the thread selection before launch",
    () =>
      Effect.gen(function* () {
        const runSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent-personal"),
          model: "claude-opus-4-6",
          options: [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
          ],
        } as const;
        const threadSelection = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        } as const;
        let hasRun = true;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: ProviderInstanceId.make("claudeAgent-work"),
          model: "claude-sonnet-4-6",
          status: "running",
          result: null,
        };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection([task])
                  : ({
                      ...childProjection,
                      thread: { ...childProjection.thread, modelSelection: threadSelection },
                      runs: hasRun
                        ? [
                            {
                              id: RunId.make("run:mcp-restarted-child"),
                              ordinal: 1,
                              status: "running",
                              modelSelection: runSelection,
                            },
                          ]
                        : [],
                    } as unknown as OrchestrationV2ThreadProjection),
              ),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([]),
          adapterRegistryLayer([]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          for (const selection of [runSelection, threadSelection]) {
            const result = yield* service.taskStatus(scope, taskId);
            assert.equal(result.providerInstanceId, selection.instanceId);
            assert.equal(result.model, selection.model);
            assert.deepEqual(result.options, selection.options);
            hasRun = false;
          }
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );
});

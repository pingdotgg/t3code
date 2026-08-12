import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OperatorService } from "./OperatorService.ts";

const NOW = "2026-08-12T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const coordinatorId = ThreadId.make("coordinator-1");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claude-work");

const project: OrchestrationProjectShell = {
  id: projectId,
  title: "T3 Code",
  workspaceRoot: "/projects/t3code",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const codexProvider: ServerProvider = {
  instanceId: codexInstanceId,
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoning_effort",
            label: "Reasoning effort",
            type: "select",
            options: [
              { id: "high", label: "High" },
              { id: "max", label: "Max" },
            ],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};

const claudeProvider: ServerProvider = {
  ...codexProvider,
  instanceId: claudeInstanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude Work",
  models: [
    {
      slug: "claude-opus-5",
      name: "Claude Opus 5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
};

function thread(id: ThreadId, overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id,
    projectId,
    title: id,
    modelSelection: { instanceId: codexInstanceId, model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feat/operator",
    worktreePath: "/worktrees/operator",
    operatorParentThreadId: null,
    operatorBatchId: null,
    operatorWorkspacePath: null,
    operatorWorkspaceBranch: null,
    operatorWaitStartedAt: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function shellFromThread(value: OrchestrationThread): OrchestrationThreadShell {
  return {
    id: value.id,
    projectId: value.projectId,
    title: value.title,
    modelSelection: value.modelSelection,
    runtimeMode: value.runtimeMode,
    interactionMode: value.interactionMode,
    branch: value.branch,
    worktreePath: value.worktreePath,
    operatorParentThreadId: value.operatorParentThreadId,
    operatorBatchId: value.operatorBatchId,
    operatorWorkspacePath: value.operatorWorkspacePath,
    operatorWorkspaceBranch: value.operatorWorkspaceBranch,
    operatorWaitStartedAt: value.operatorWaitStartedAt,
    latestTurn: value.latestTurn,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archivedAt: value.archivedAt,
    settledOverride: value.settledOverride,
    settledAt: value.settledAt,
    session: value.session,
    latestUserMessageAt:
      value.messages.findLast((message) => message.role === "user")?.createdAt ?? null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

interface HarnessOptions {
  readonly agenticOperatorEnabled?: boolean;
  readonly coordinator?: OrchestrationThread;
  readonly children?: ReadonlyArray<OrchestrationThread>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly readEvents?: (cursor: number) => Stream.Stream<OrchestrationEvent>;
  readonly streamDomainEvents?: Stream.Stream<OrchestrationEvent>;
  readonly onCreateWorktree?: GitWorkflowService["Service"]["createWorktree"];
  readonly onRunSetupScript?: ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly onDispatch?: (command: OrchestrationCommand) => void;
}

function makeHarness(options: HarnessOptions = {}) {
  const details = new Map<ThreadId, OrchestrationThread>();
  const commands: OrchestrationCommand[] = [];
  const initialCoordinator = options.coordinator ?? thread(coordinatorId);
  details.set(initialCoordinator.id, initialCoordinator);
  for (const child of options.children ?? []) {
    details.set(child.id, child);
  }
  let sequence = 0;

  const dispatch = (command: OrchestrationCommand) =>
    Effect.sync(() => {
      commands.push(command);
      options.onDispatch?.(command);
      sequence += 1;
      if (command.type === "thread.meta.update") {
        const current = details.get(command.threadId);
        if (current) {
          details.set(command.threadId, {
            ...current,
            ...(command.operatorWorkspacePath === undefined
              ? {}
              : { operatorWorkspacePath: command.operatorWorkspacePath }),
            ...(command.operatorWorkspaceBranch === undefined
              ? {}
              : { operatorWorkspaceBranch: command.operatorWorkspaceBranch }),
            ...(command.operatorWaitStartedAt === undefined
              ? {}
              : { operatorWaitStartedAt: command.operatorWaitStartedAt }),
          });
        }
      }
      if (command.type === "thread.create") {
        details.set(
          command.threadId,
          thread(command.threadId, {
            title: command.title,
            modelSelection: command.modelSelection,
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            branch: command.branch,
            worktreePath: command.worktreePath,
            operatorParentThreadId: command.operatorParentThreadId ?? null,
            operatorBatchId: command.operatorBatchId ?? null,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          }),
        );
      }
      if (command.type === "thread.turn.start") {
        const current = details.get(command.threadId);
        if (current) {
          details.set(command.threadId, {
            ...current,
            latestTurn: {
              turnId: TurnId.make(`turn-${sequence}`),
              state: "running",
              requestedAt: command.createdAt,
              startedAt: command.createdAt,
              completedAt: null,
              assistantMessageId: null,
            },
            messages: [
              ...current.messages,
              {
                id: command.message.messageId,
                role: "user",
                text: command.message.text,
                attachments: command.message.attachments,
                turnId: null,
                streaming: false,
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
              },
            ],
          });
        }
      }
      return { sequence };
    });

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: (id) =>
        Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      getThreadDetailById: (id) => Effect.succeed(Option.fromNullishOr(details.get(id))),
      getThreadShellById: (id) =>
        Effect.succeed(Option.fromNullishOr(details.get(id)).pipe(Option.map(shellFromThread))),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: sequence,
          projects: [project],
          threads: Array.from(details.values(), shellFromThread),
          updatedAt: NOW,
        }),
    }),
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.succeed(options.providers ?? [codexProvider]),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch,
      readEvents: (cursor) => options.readEvents?.(cursor) ?? Stream.empty,
      streamDomainEvents: options.streamDomainEvents ?? Stream.empty,
      latestSequence: Effect.sync(() => sequence),
    }),
    Layer.mock(GitWorkflowService)({
      createWorktree:
        options.onCreateWorktree ??
        (() => Effect.die("createWorktree was not expected in this test")),
    }),
    Layer.mock(ProjectSetupScriptRunner)({
      runForThread:
        options.onRunSetupScript ??
        (() => Effect.die("runForThread was not expected in this test")),
    }),
    ServerSettingsService.layerTest({
      agenticOperatorEnabled: options.agenticOperatorEnabled ?? true,
    }),
    NodeServices.layer,
  );

  return {
    commands,
    details,
    layer: OperatorService.layer.pipe(Layer.provide(dependencies)),
  };
}

describe("OperatorService", () => {
  it.effect("refuses every Operator action until it is enabled in Settings", () => {
    const harness = makeHarness({ agenticOperatorEnabled: false });
    return Effect.gen(function* () {
      const operator = yield* OperatorService;
      const error = yield* operator.listModels(coordinatorId).pipe(Effect.flip);

      assert.equal(error.reason, "disabled");
      assert.match(error.detail, /Settings > Agentic Operator/i);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lists only active providers and rejects unsupported reasoning values", () => {
    const harness = makeHarness({
      providers: [codexProvider, { ...claudeProvider, enabled: false }],
    });
    return Effect.gen(function* () {
      const operator = yield* OperatorService;
      const inventory = yield* operator.listModels(coordinatorId);

      assert.deepStrictEqual(inventory, [
        {
          instanceId: codexInstanceId,
          driver: "codex",
          displayName: "Codex",
          available: true,
          models: codexProvider.models.map((model) => ({
            slug: model.slug,
            name: model.name,
            capabilities: model.capabilities,
          })),
        },
      ]);

      const error = yield* operator
        .spawn({
          coordinatorThreadId: coordinatorId,
          workspaceMode: "current",
          tasks: [
            {
              title: "Backend",
              prompt: "Build the backend.",
              modelSelection: {
                instanceId: codexInstanceId,
                model: "gpt-5.6-sol",
                options: [{ id: "reasoning_effort", value: "ultra" }],
              },
            },
          ],
        })
        .pipe(Effect.flip);

      assert.equal(error.reason, "invalid-options");
      assert.match(error.detail, /not valid/);
      assert.equal(harness.commands.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("spawns exact-model child threads in one shared checkout", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const operator = yield* OperatorService;
      const result = yield* operator.spawn({
        coordinatorThreadId: coordinatorId,
        workspaceMode: "current",
        tasks: [
          {
            title: "Frontend",
            prompt: "Implement the frontend files only.",
            modelSelection: {
              instanceId: codexInstanceId,
              model: "gpt-5.6-sol",
              options: [{ id: "reasoning_effort", value: "high" }],
            },
          },
          {
            title: "Backend",
            prompt: "Implement the backend files only.",
            modelSelection: {
              instanceId: codexInstanceId,
              model: "gpt-5.6-sol",
              options: [{ id: "reasoning_effort", value: "max" }],
            },
          },
        ],
      });

      assert.equal(result.workspacePath, "/worktrees/operator");
      assert.equal(result.branch, "feat/operator");
      assert.deepStrictEqual(
        result.tasks.map((task) => ({ title: task.title, status: task.status })),
        [
          { title: "Frontend", status: "running" },
          { title: "Backend", status: "running" },
        ],
      );

      const creates = harness.commands.filter((command) => command.type === "thread.create");
      const starts = harness.commands.filter((command) => command.type === "thread.turn.start");
      assert.equal(creates.length, 2);
      assert.equal(starts.length, 2);
      assert.equal(creates[0]?.worktreePath, "/worktrees/operator");
      assert.equal(creates[1]?.worktreePath, "/worktrees/operator");
      assert.equal(creates[0]?.operatorParentThreadId, coordinatorId);
      assert.equal(creates[0]?.operatorBatchId, creates[1]?.operatorBatchId);
      assert.equal(starts[0]?.modelSelection?.options?.[0]?.value, "high");
      assert.equal(starts[1]?.modelSelection?.options?.[0]?.value, "max");
      assert.match(
        starts[0]?.message.text ?? "",
        /Other Operator tasks may edit this same checkout/,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("creates a Claude sidebar task from a Codex coordinator without substitution", () => {
    const harness = makeHarness({ providers: [codexProvider, claudeProvider] });
    return Effect.gen(function* () {
      const operator = yield* OperatorService;
      yield* operator.spawn({
        coordinatorThreadId: coordinatorId,
        workspaceMode: "current",
        tasks: [
          {
            title: "Frontend",
            prompt: "Implement the frontend.",
            modelSelection: {
              instanceId: claudeInstanceId,
              model: "claude-opus-5",
              options: [{ id: "effort", value: "high" }],
            },
          },
        ],
      });

      const create = harness.commands.find((command) => command.type === "thread.create");
      const start = harness.commands.find((command) => command.type === "thread.turn.start");
      assert.deepStrictEqual(create?.modelSelection, {
        instanceId: claudeInstanceId,
        model: "claude-opus-5",
        options: [{ id: "effort", value: "high" }],
      });
      assert.deepStrictEqual(start?.modelSelection, create?.modelSelection);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("runs a fresh worktree setup once before starting its child turns", () => {
    const order: string[] = [];
    const harness = makeHarness({
      onCreateWorktree: () =>
        Effect.sync(() => {
          order.push("worktree");
          return {
            worktree: { path: "/worktrees/operator-new", refName: "feat/operator-new" },
          };
        }),
      onRunSetupScript: () =>
        Effect.sync(() => {
          order.push("setup");
          return { status: "no-script" as const };
        }),
      onDispatch: (command) => {
        if (command.type === "thread.turn.start") {
          order.push("start");
        }
      },
    });
    return Effect.gen(function* () {
      const operator = yield* OperatorService;
      yield* operator.spawn({
        coordinatorThreadId: coordinatorId,
        workspaceMode: "new-worktree",
        branch: "feat/operator-new",
        baseBranch: "main",
        tasks: [
          {
            title: "Implementation",
            prompt: "Implement the feature.",
            modelSelection: {
              instanceId: codexInstanceId,
              model: "gpt-5.6-sol",
              options: [{ id: "reasoning_effort", value: "high" }],
            },
          },
        ],
      });

      const firstStartIndex = harness.commands.findIndex(
        (command) => command.type === "thread.turn.start",
      );
      assert.deepStrictEqual(order, ["worktree", "setup", "start"]);
      assert.notEqual(firstStartIndex, -1);
      assert.equal(harness.commands.slice(0, firstStartIndex).at(-1)?.type, "thread.create");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("waits on orchestration events and returns the child handoff", () => {
    const taskId = ThreadId.make("operator-task-1");
    const turnId = TurnId.make("operator-turn-1");
    const running = thread(taskId, {
      title: "Backend",
      operatorParentThreadId: coordinatorId,
      operatorBatchId: "batch-1",
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    let readCursor: number | null = null;
    let harness: ReturnType<typeof makeHarness>;
    const completionEvent: OrchestrationEvent = {
      sequence: 1,
      eventId: EventId.make("event-complete"),
      aggregateKind: "thread",
      aggregateId: taskId,
      occurredAt: "2026-08-12T10:01:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.meta-updated",
      payload: {
        threadId: taskId,
        updatedAt: "2026-08-12T10:01:00.000Z",
      },
    };
    harness = makeHarness({
      children: [running],
      readEvents: (cursor) =>
        Stream.fromEffect(
          Effect.sync(() => {
            readCursor = cursor;
            harness.details.set(
              taskId,
              thread(taskId, {
                title: "Backend",
                operatorParentThreadId: coordinatorId,
                operatorBatchId: "batch-1",
                latestTurn: {
                  turnId,
                  state: "completed",
                  requestedAt: NOW,
                  startedAt: NOW,
                  completedAt: "2026-08-12T10:01:00.000Z",
                  assistantMessageId: MessageId.make("assistant-1"),
                },
                messages: [
                  {
                    id: MessageId.make("assistant-1"),
                    role: "assistant",
                    text: "Backend implementation is ready.",
                    turnId,
                    streaming: false,
                    createdAt: "2026-08-12T10:01:00.000Z",
                    updatedAt: "2026-08-12T10:01:00.000Z",
                  },
                ],
              }),
            );
            return completionEvent;
          }),
        ),
    });

    return Effect.gen(function* () {
      const operator = yield* OperatorService;
      const tasks = yield* operator.wait(coordinatorId, [taskId]);

      assert.equal(readCursor, 0);
      const waitUpdates = harness.commands
        .filter((command) => command.type === "thread.meta.update")
        .map((command) => command.operatorWaitStartedAt);
      assert.equal(waitUpdates.length, 2);
      assert.equal(typeof waitUpdates[0], "string");
      assert.equal(waitUpdates[1], null);
      assert.deepStrictEqual(tasks, [
        {
          taskId,
          batchId: "batch-1",
          title: "Backend",
          modelSelection: { instanceId: codexInstanceId, model: "gpt-5.6-sol" },
          status: "completed",
          startedAt: NOW,
          completedAt: "2026-08-12T10:01:00.000Z",
          result: "Backend implementation is ready.",
          error: null,
        },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });
});

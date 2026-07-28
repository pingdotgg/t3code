import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
  type WorkflowModelRouting,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../../provider/Services/ProviderService.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { __testing, DelegateCoordinator } from "./DelegateCoordinator.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });

const makeProvider = (instanceId: string, driver: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [
    {
      slug: "default-model",
      name: "Default Model",
      isCustom: false,
      capabilities: emptyCapabilities,
    },
  ],
  slashCommands: [],
  skills: [],
});

const parentThreadId = ThreadId.make("parent-thread");
const projectId = "project-1";

const makeScope = (threadId: ThreadId = parentThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["agents"]),
  issuedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

const makeThreadShell = (
  threadId: ThreadId,
  overrides?: Partial<OrchestrationThreadShell>,
): OrchestrationThreadShell =>
  ({
    id: threadId,
    projectId,
    title: "Parent thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claude"),
      model: "claude-sonnet-5",
      options: [{ id: "effort", value: "high" }],
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    executorModelSelection: null,
    executorMaxSubAgents: 3,
    branch: "feature/foo",
    worktreePath: "/tmp/worktrees/foo",
    parentThreadId: null,
    latestTurn: null,
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  }) as OrchestrationThreadShell;

const makeThreadDetail = (
  threadId: ThreadId,
  overrides?: Partial<OrchestrationThread>,
): OrchestrationThread =>
  ({
    id: threadId,
    projectId,
    title: "Agent: child",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    executorModelSelection: null,
    executorMaxSubAgents: 3,
    branch: null,
    worktreePath: null,
    parentThreadId,
    latestTurn: null,
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  }) as OrchestrationThread;

const completedChildDetail = (threadId: ThreadId): OrchestrationThread =>
  makeThreadDetail(threadId, {
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "completed",
      requestedAt: "2026-04-12T00:00:00.000Z",
      startedAt: "2026-04-12T00:00:00.000Z",
      completedAt: "2026-04-12T00:01:00.000Z",
      assistantMessageId: MessageId.make("assistant-1"),
    },
    messages: [
      {
        id: MessageId.make("assistant-1"),
        role: "assistant",
        text: "All done.",
        turnId: TurnId.make("turn-1"),
        streaming: false,
        createdAt: "2026-04-12T00:01:00.000Z",
        updatedAt: "2026-04-12T00:01:00.000Z",
      },
    ],
  } as Partial<OrchestrationThread>);

interface Harness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly setThreadDetail: (
    lookup: (threadId: ThreadId) => Option.Option<OrchestrationThread>,
  ) => void;
}

const makeCoordinator = (options?: {
  readonly parentShell?: (threadId: ThreadId) => OrchestrationThreadShell;
  readonly noteSessionActivity?: (threadId: ThreadId) => Effect.Effect<void>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly workflowModelRouting?: WorkflowModelRouting;
}): Effect.Effect<readonly [DelegateCoordinator["Service"], Harness], never, never> => {
  const dispatched: Array<OrchestrationCommand> = [];
  let threadDetailLookup: (threadId: ThreadId) => Option.Option<OrchestrationThread> = () =>
    Option.none();

  const engine = OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
    streamDomainEvents: Stream.never,
    streamThreadEvents: () => Stream.never,
  });

  const unused = () => Effect.die("unused in DelegateCoordinator tests");
  const snapshotQuery = ProjectionSnapshotQuery.of({
    getCommandReadModel: unused,
    getSnapshot: unused,
    getShellSnapshot: unused,
    getArchivedShellSnapshot: unused,
    getSnapshotSequence: unused,
    getCounts: unused,
    getActiveProjectByWorkspaceRoot: unused,
    getProjectShellById: unused,
    getFirstActiveThreadIdByProjectId: unused,
    getThreadCheckpointContext: unused,
    getFullThreadDiffContext: unused,
    getThreadShellById: (threadId) =>
      Effect.succeed(Option.some((options?.parentShell ?? makeThreadShell)(threadId))),
    getThreadDetailById: (threadId) => Effect.sync(() => threadDetailLookup(threadId)),
    getThreadDetailSnapshot: unused,
    listChildThreadRefs: () => Effect.succeed([]),
  });

  const providerRegistry = ProviderRegistry.of({
    getProviders: Effect.succeed(options?.providers ?? [makeProvider("claude", "claudeAgent")]),
    refresh: unused,
    refreshInstance: unused,
    getProviderMaintenanceCapabilitiesForInstance: unused,
    setProviderMaintenanceActionState: unused,
    streamChanges: Stream.never,
  });

  const providerServiceLayer = options?.noteSessionActivity
    ? Layer.succeed(ProviderService, {
        noteSessionActivity: options.noteSessionActivity,
      } as unknown as ProviderServiceShape)
    : Layer.empty;
  const serverSettingsLayer = options?.workflowModelRouting
    ? ServerSettingsService.layerTest({ workflowModelRouting: options.workflowModelRouting })
    : Layer.empty;

  const layer = Layer.effect(DelegateCoordinator, __testing.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, engine),
        Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
        Layer.succeed(ProviderRegistry, providerRegistry),
        providerServiceLayer,
        serverSettingsLayer,
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const coordinator = yield* DelegateCoordinator;
    const harness: Harness = {
      dispatched,
      setThreadDetail: (lookup) => {
        threadDetailLookup = lookup;
      },
    };
    return [coordinator, harness] as const;
  }).pipe(Effect.provide(layer));
};

it.effect("delegates a task and returns the child's final message", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();
    harness.setThreadDetail((threadId) => Option.some(completedChildDetail(threadId)));

    const result = yield* coordinator.delegate(makeScope(), {
      prompt: "Review the diff",
      name: "reviewer",
    });

    expect(result.status).toBe("completed");
    expect(result.result).toBe("All done.");
    expect(result.truncated).toBe(false);

    const create = harness.dispatched.find((command) => command.type === "thread.create");
    expect(create).toMatchObject({
      title: "Agent: reviewer",
      parentThreadId,
      projectId,
      branch: "feature/foo",
      worktreePath: "/tmp/worktrees/foo",
      modelSelection: expect.objectContaining({ model: "claude-sonnet-5" }),
    });
    expect(harness.dispatched.some((command) => command.type === "thread.turn.start")).toBe(true);
    expect(harness.dispatched.some((command) => command.type === "thread.archive")).toBe(true);

    const activities = harness.dispatched.filter(
      (command) => command.type === "thread.activity.append",
    );
    expect(activities.some((command) => command.activity.kind === "task.started")).toBe(true);
    expect(activities.some((command) => command.activity.kind === "task.completed")).toBe(true);
  }),
);

it.effect("refuses delegation from a delegated child thread", () =>
  Effect.gen(function* () {
    const [coordinator] = yield* makeCoordinator({
      parentShell: (threadId) =>
        makeThreadShell(threadId, { parentThreadId: ThreadId.make("grandparent") }),
    });

    const error = yield* coordinator
      .delegate(makeScope(), { prompt: "nest deeper" })
      .pipe(Effect.flip);

    expect(error._tag).toBe("DelegateError");
    expect(error.reason).toBe("depth-limit-exceeded");
  }),
);

it.effect("caps concurrent delegations per parent at three", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();
    // Children stay running: no latestTurn and no failure activities.
    harness.setThreadDetail((threadId) => Option.some(makeThreadDetail(threadId)));

    const fibers = yield* Effect.all(
      [1, 2, 3].map((index) =>
        coordinator.delegate(makeScope(), { prompt: `task ${index}` }).pipe(Effect.forkChild),
      ),
    );
    yield* TestClock.adjust(Duration.millis(10));

    const error = yield* coordinator
      .delegate(makeScope(), { prompt: "one too many" })
      .pipe(Effect.flip);
    expect(error._tag).toBe("DelegateError");
    expect(error.reason).toBe("concurrency-limit-exceeded");

    yield* Effect.all(fibers.map((fiber) => Fiber.interrupt(fiber)));
  }),
);

it.effect("reports a missing delegated thread as an error result", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();
    harness.setThreadDetail(() => Option.none());

    const result = yield* coordinator.delegate(makeScope(), { prompt: "vanished" });
    expect(result.status).toBe("error");
  }),
);

it.effect("advisor parent with an executor model delegates on the executor selection", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator({
      parentShell: (threadId) =>
        makeThreadShell(threadId, {
          interactionMode: "advisor",
          executorModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6",
          },
        }),
    });
    harness.setThreadDetail((threadId) => Option.some(completedChildDetail(threadId)));

    const result = yield* coordinator.delegate(makeScope(), { prompt: "Implement the plan" });
    expect(result.status).toBe("completed");

    const create = harness.dispatched.find((command) => command.type === "thread.create");
    expect(create).toMatchObject({
      // The child runs on the user-configured executor model, not the
      // advisor's own model.
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
      // Executor children are pure executors: default interaction mode, the
      // parent thread's stored runtime mode, and a parentThreadId that bars
      // them from delegating further.
      interactionMode: "default",
      runtimeMode: "approval-required",
      parentThreadId,
    });
  }),
);

it.effect("task roles use an available configured workflow model", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator({
      providers: [makeProvider("claude", "claudeAgent"), makeProvider("codex", "codex")],
      workflowModelRouting: {
        explore: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "default-model",
        },
        implement: null,
        verify: null,
      },
    });
    harness.setThreadDetail((threadId) => Option.some(completedChildDetail(threadId)));

    yield* coordinator.delegate(makeScope(), {
      role: "explore",
      prompt: "Map the relevant code",
    });

    const create = harness.dispatched.find((command) => command.type === "thread.create");
    expect(create).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "default-model",
      },
    });
  }),
);

it.effect("advisor parent without an executor model keeps delegating on its own model", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator({
      parentShell: (threadId) => makeThreadShell(threadId, { interactionMode: "advisor" }),
    });
    harness.setThreadDetail((threadId) => Option.some(completedChildDetail(threadId)));

    yield* coordinator.delegate(makeScope(), { prompt: "Implement the plan" });

    const create = harness.dispatched.find((command) => command.type === "thread.create");
    expect(create).toMatchObject({
      modelSelection: expect.objectContaining({ model: "claude-sonnet-5" }),
    });
  }),
);

it.effect("advisor parent honors its configured executor sub-agent cap", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator({
      parentShell: (threadId) =>
        makeThreadShell(threadId, {
          interactionMode: "advisor",
          executorMaxSubAgents: 1,
        }),
    });
    // Children stay running: no latestTurn and no failure activities.
    harness.setThreadDetail((threadId) => Option.some(makeThreadDetail(threadId)));

    const fiber = yield* coordinator
      .delegate(makeScope(), { prompt: "first task" })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(10));

    const error = yield* coordinator
      .delegate(makeScope(), { prompt: "over the configured cap" })
      .pipe(Effect.flip);
    expect(error._tag).toBe("DelegateError");
    expect(error.reason).toBe("concurrency-limit-exceeded");
    expect(error.description).toContain("max 1");

    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("sanitizes agent names into thread titles", () =>
  Effect.sync(() => {
    expect(__testing.resolveTitle({ prompt: "do work", name: "  my\nagent  " })).toBe(
      "Agent: my agent",
    );
    expect(__testing.resolveTitle({ prompt: "first line\nsecond line" })).toBe("Agent: first line");
  }),
);

it.effect("heartbeats the parent's session activity while the delegated child runs", () =>
  Effect.gen(function* () {
    const noted: Array<ThreadId> = [];
    const [coordinator, harness] = yield* makeCoordinator({
      noteSessionActivity: (threadId) =>
        Effect.sync(() => {
          noted.push(threadId);
        }),
    });
    // The child stays running: no latestTurn and no failure activities.
    harness.setThreadDetail((threadId) => Option.some(makeThreadDetail(threadId)));

    // The parent turn is blocked on the delegate call and emits no runtime
    // events of its own; the coordinator must keep the parent's turn-activity
    // watchdog alive so the thread is not flagged as stalled.
    const fiber = yield* coordinator
      .delegate(makeScope(), { prompt: "long running task" })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.seconds(5));
    yield* Fiber.interrupt(fiber);

    expect(noted.length).toBeGreaterThan(0);
    expect(noted.every((threadId) => threadId === parentThreadId)).toBe(true);
  }),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
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
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
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
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-04-12T00:00:00.000Z",
      startedAt: "2026-04-12T00:00:00.000Z",
      completedAt: "2026-04-12T00:01:00.000Z",
      assistantMessageId: "assistant-1",
    },
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        text: "All done.",
        turnId: "turn-1",
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
}): Effect.Effect<
  readonly [DelegateCoordinator["Service"], Harness],
  never,
  NodeServices.NodeServices
> => {
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
    getProviders: Effect.succeed([makeProvider("claude", "claudeAgent")]),
    refresh: unused,
    refreshInstance: unused,
    getProviderMaintenanceCapabilitiesForInstance: unused,
    setProviderMaintenanceActionState: unused,
    streamChanges: Stream.never,
  });

  const layer = Layer.effect(DelegateCoordinator, __testing.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, engine),
        Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
        Layer.succeed(ProviderRegistry, providerRegistry),
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

it.effect("sanitizes agent names into thread titles", () =>
  Effect.sync(() => {
    expect(__testing.resolveTitle({ prompt: "do work", name: "  my\nagent  " })).toBe(
      "Agent: my agent",
    );
    expect(__testing.resolveTitle({ prompt: "first line\nsecond line" })).toBe("Agent: first line");
  }),
);

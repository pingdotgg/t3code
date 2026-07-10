import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerProvider,
  type SubAgentError,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import { SubAgentCoordinator, __testing } from "./SubAgentCoordinator.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });

const makeProvider = (
  instanceId: string,
  driver: string,
  overrides?: Partial<ServerProvider>,
): ServerProvider => ({
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
  ...overrides,
});

const parentThreadId = ThreadId.make("parent-thread");
const projectId = "project-1";

const makeScope = (threadId: ThreadId = parentThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["preview", "agents"]),
  issuedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

const makeThreadShell = (threadId: ThreadId): OrchestrationThreadShell =>
  ({
    id: threadId,
    projectId,
    title: "Parent thread",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: "feature/foo",
    worktreePath: "/tmp/worktrees/foo",
    latestTurn: null,
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }) as OrchestrationThreadShell;

const makeThreadDetail = (
  threadId: ThreadId,
  overrides?: Partial<OrchestrationThread>,
): OrchestrationThread =>
  ({
    id: threadId,
    projectId,
    title: "Sub-agent thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default-model" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
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

interface Harness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly setThreadDetail: (
    lookup: (threadId: ThreadId) => Option.Option<OrchestrationThread>,
  ) => void;
}

const makeCoordinator = (options?: {
  readonly providers?: ReadonlyArray<ServerProvider>;
}): Effect.Effect<readonly [SubAgentCoordinator["Service"], Harness], never, never> => {
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

  const unused = () => Effect.die("unused in SubAgentCoordinator tests");
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
    getThreadShellById: (threadId) => Effect.succeed(Option.some(makeThreadShell(threadId))),
    getThreadDetailById: (threadId) => Effect.sync(() => threadDetailLookup(threadId)),
  });

  const providers = options?.providers ?? [
    makeProvider("claude", "claudeAgent"),
    makeProvider("codex", "codex"),
  ];
  const providerRegistry = ProviderRegistry.of({
    getProviders: Effect.succeed(providers),
    refresh: unused,
    refreshInstance: unused,
    getProviderMaintenanceCapabilitiesForInstance: unused,
    setProviderMaintenanceActionState: unused,
    streamChanges: Stream.never,
  });

  const harness: Harness = {
    dispatched,
    setThreadDetail: (lookup) => {
      threadDetailLookup = lookup;
    },
  };

  return __testing.make.pipe(
    Effect.provideService(OrchestrationEngineService, engine),
    Effect.provideService(ProjectionSnapshotQuery, snapshotQuery),
    Effect.provideService(ProviderRegistry, providerRegistry),
    Effect.provide(NodeServices.layer),
    Effect.map((coordinator) => [coordinator, harness] as const),
  );
};

const expectSubAgentError = <A>(effect: Effect.Effect<A, SubAgentError>) => Effect.flip(effect);

it.effect("spawns a sub-agent thread next to the caller's thread on another provider", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();

    const result = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("codex"),
      prompt: "Review the auth module for bugs.",
    });

    expect(result.status).toBe("running");
    expect(result.providerInstanceId).toBe("codex");
    expect(result.model).toBe("default-model");
    expect(result.title).toBe("Review the auth module for bugs.");
    expect(result.name).toBeUndefined();

    expect(harness.dispatched).toHaveLength(2);
    const [create, turnStart] = harness.dispatched;
    expect(create?.type).toBe("thread.create");
    if (create?.type === "thread.create") {
      expect(create.threadId).toBe(result.threadId);
      expect(create.projectId).toBe(projectId);
      expect(create.worktreePath).toBe("/tmp/worktrees/foo");
      expect(create.branch).toBe("feature/foo");
      expect(create.runtimeMode).toBe("approval-required");
      expect(create.modelSelection).toEqual({ instanceId: "codex", model: "default-model" });
    }
    expect(turnStart?.type).toBe("thread.turn.start");
    if (turnStart?.type === "thread.turn.start") {
      expect(turnStart.threadId).toBe(result.threadId);
      expect(turnStart.message.text).toBe("Review the auth module for bugs.");
      expect(turnStart.runtimeMode).toBe("approval-required");
    }
  }),
);

it.effect("names a spawned agent and surfaces it on agent_list", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();

    const result = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("codex"),
      prompt: "Audit the payments module carefully.",
      name: "payments-auditor",
    });

    expect(result.name).toBe("payments-auditor");
    expect(result.title).toBe("Agent: payments-auditor");

    const create = harness.dispatched.find((command) => command.type === "thread.create");
    expect(create?.type).toBe("thread.create");
    if (create?.type === "thread.create") {
      expect(create.title).toBe("Agent: payments-auditor");
    }

    const listed = yield* coordinator.list(makeScope());
    expect(listed.agents).toEqual([
      {
        threadId: result.threadId,
        name: "payments-auditor",
        title: "Agent: payments-auditor",
        providerInstanceId: "codex",
        model: "default-model",
      },
    ]);

    // Other sessions do not see this caller's spawned agents.
    const foreign = yield* coordinator.list(makeScope(ThreadId.make("other-parent")));
    expect(foreign.agents).toEqual([]);
  }),
);

it.effect("prefers name over an explicit title for the Agent: prefix", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();

    const result = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("codex"),
      prompt: "Do the work.",
      name: "worker-a",
      title: "Custom title that should lose",
    });

    expect(result.title).toBe("Agent: worker-a");
    const create = harness.dispatched.find((command) => command.type === "thread.create");
    if (create?.type === "thread.create") {
      expect(create.title).toBe("Agent: worker-a");
    }
  }),
);

it.effect("rejects spawn targets that are unknown or not ready", () =>
  Effect.gen(function* () {
    const [coordinator] = yield* makeCoordinator({
      providers: [
        makeProvider("claude", "claudeAgent"),
        makeProvider("codex", "codex", { status: "error", auth: { status: "unauthenticated" } }),
      ],
    });

    const unknown = yield* expectSubAgentError(
      coordinator.spawn(makeScope(), {
        providerInstanceId: ProviderInstanceId.make("missing"),
        prompt: "Do something.",
      }),
    );
    expect(unknown.reason).toBe("provider-not-found");

    const notReady = yield* expectSubAgentError(
      coordinator.spawn(makeScope(), {
        providerInstanceId: ProviderInstanceId.make("codex"),
        prompt: "Do something.",
      }),
    );
    expect(notReady.reason).toBe("provider-not-spawnable");
  }),
);

it.effect("bounds recursive sub-agent nesting", () =>
  Effect.gen(function* () {
    const [coordinator] = yield* makeCoordinator();

    const first = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("codex"),
      prompt: "Level one task.",
    });

    const childScope = makeScope(first.threadId);
    const second = yield* coordinator
      .spawn(childScope, {
        providerInstanceId: ProviderInstanceId.make("claude"),
        prompt: "Level two task.",
      })
      .pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            // Depth 1 caller must still be allowed; only depth 2 is refused.
            throw new Error(`unexpected refusal at depth 1: ${error.description}`);
          }),
        ),
      );

    const grandchildScope = makeScope(second.threadId);
    const refused = yield* expectSubAgentError(
      coordinator.spawn(grandchildScope, {
        providerInstanceId: ProviderInstanceId.make("codex"),
        prompt: "Level three task.",
      }),
    );
    expect(refused.reason).toBe("depth-limit-exceeded");
  }),
);

it.effect("refuses to drive threads the calling session did not spawn", () =>
  Effect.gen(function* () {
    const [coordinator] = yield* makeCoordinator();

    const send = yield* expectSubAgentError(
      coordinator.send(makeScope(), { threadId: ThreadId.make("foreign-thread"), prompt: "hi" }),
    );
    expect(send.reason).toBe("thread-not-found");

    const wait = yield* expectSubAgentError(
      coordinator.wait(makeScope(), { threadId: ThreadId.make("foreign-thread") }),
    );
    expect(wait.reason).toBe("thread-not-found");
  }),
);

it.effect("waits for the spawned turn to complete and returns the assistant text", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();

    const spawned = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("codex"),
      prompt: "Summarize the repo.",
    });

    const assistantMessageId = MessageId.make("assistant-message-1");
    const turnId = TurnId.make("turn-1");
    harness.setThreadDetail((threadId) =>
      threadId === spawned.threadId
        ? Option.some(
            makeThreadDetail(spawned.threadId, {
              latestTurn: {
                turnId,
                state: "completed",
                requestedAt: "9999-01-01T00:00:00.000Z",
                startedAt: "9999-01-01T00:00:00.000Z",
                completedAt: "9999-01-01T00:00:01.000Z",
                assistantMessageId,
              },
              messages: [
                {
                  id: assistantMessageId,
                  role: "assistant",
                  text: "The repo is a coding-agent GUI.",
                  turnId,
                  streaming: false,
                  createdAt: "9999-01-01T00:00:01.000Z",
                  updatedAt: "9999-01-01T00:00:01.000Z",
                },
              ],
            }),
          )
        : Option.none(),
    );

    const result = yield* coordinator.wait(makeScope(), {
      threadId: spawned.threadId,
      timeoutSeconds: 5,
    });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("The repo is a coding-agent GUI.");
  }),
);

it.effect("reports running when the sub-agent has not finished before the timeout", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();

    const spawned = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("codex"),
      prompt: "Long running task.",
    });
    harness.setThreadDetail((threadId) =>
      threadId === spawned.threadId
        ? Option.some(makeThreadDetail(spawned.threadId, { latestTurn: null }))
        : Option.none(),
    );

    const waiting = yield* coordinator
      .wait(makeScope(), {
        threadId: spawned.threadId,
        timeoutSeconds: 1,
      })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.seconds(2));
    const result = yield* Fiber.join(waiting);
    expect(result.status).toBe("running");
    expect(result.finalText).toBeNull();
  }),
);

it.effect("reports error when the provider fails before the turn is created", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();

    const spawned = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("codex"),
      prompt: "Task that never starts.",
    });
    // A pre-turn failure (invalid model, session start error) leaves latestTurn
    // null; ProviderCommandReactor records it only as an error activity.
    harness.setThreadDetail((threadId) =>
      threadId === spawned.threadId
        ? Option.some(
            makeThreadDetail(spawned.threadId, {
              latestTurn: null,
              activities: [
                {
                  id: EventId.make("event-1"),
                  tone: "error",
                  kind: "provider.turn.start.failed",
                  summary: "Provider turn start failed",
                  payload: { detail: "model not found" },
                  turnId: null,
                  createdAt: "9999-01-01T00:00:00.000Z",
                },
              ],
            }),
          )
        : Option.none(),
    );

    const result = yield* coordinator.wait(makeScope(), {
      threadId: spawned.threadId,
      timeoutSeconds: 5,
    });
    expect(result.status).toBe("error");
    expect(result.finalText).toBeNull();
  }),
);

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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../../provider/Services/ProviderService.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import { __testing } from "./SubAgentCoordinator.ts";
import type { SubAgentCoordinator } from "./SubAgentCoordinator.ts";

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
  readonly setSessionActivity: (
    lookup: (
      threadId: ThreadId,
    ) => { readonly lastActivityAt: string; readonly stalled: boolean } | undefined,
  ) => void;
}

const makeCoordinator = (options?: {
  readonly providers?: ReadonlyArray<ServerProvider>;
}): Effect.Effect<readonly [SubAgentCoordinator["Service"], Harness], never, never> => {
  const dispatched: Array<OrchestrationCommand> = [];
  let threadDetailLookup: (threadId: ThreadId) => Option.Option<OrchestrationThread> = () =>
    Option.none();
  let sessionActivityLookup: (
    threadId: ThreadId,
  ) => { readonly lastActivityAt: string; readonly stalled: boolean } | undefined = () => undefined;

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
  const providerService = ProviderService.of({
    getSessionActivity: (threadId) => Effect.sync(() => sessionActivityLookup(threadId)),
    startSession: unused,
    sendTurn: unused,
    interruptTurn: unused,
    stopTask: unused,
    respondToRequest: unused,
    respondToUserInput: unused,
    stopSession: unused,
    listSessions: unused,
    getCapabilities: unused,
    getInstanceInfo: unused,
    rollbackConversation: unused,
    streamEvents: Stream.never,
  });

  const harness: Harness = {
    dispatched,
    setThreadDetail: (lookup) => {
      threadDetailLookup = lookup;
    },
    setSessionActivity: (lookup) => {
      sessionActivityLookup = lookup;
    },
  };

  return __testing.make.pipe(
    Effect.provideService(OrchestrationEngineService, engine),
    Effect.provideService(ProjectionSnapshotQuery, snapshotQuery),
    Effect.provideService(ProviderRegistry, providerRegistry),
    Effect.provideService(ProviderService, providerService),
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

it.effect("inherits the caller model when the target instance exposes it", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator({
      providers: [
        makeProvider("claude", "claudeAgent", {
          models: [
            {
              slug: "opus",
              name: "Claude Opus",
              isCustom: false,
              capabilities: emptyCapabilities,
            },
            {
              slug: "default-model",
              name: "Default Model",
              isCustom: false,
              capabilities: emptyCapabilities,
            },
          ],
        }),
        makeProvider("codex", "codex"),
      ],
    });

    const result = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("claude"),
      prompt: "Use the caller's model.",
    });

    expect(result.model).toBe("opus");
    const create = harness.dispatched.find((command) => command.type === "thread.create");
    expect(create).toMatchObject({
      type: "thread.create",
      modelSelection: { instanceId: "claude", model: "opus" },
    });
  }),
);

it.effect("falls back to the target's first model when the caller model is unavailable", () =>
  Effect.gen(function* () {
    const [coordinator] = yield* makeCoordinator();

    const result = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("claude"),
      prompt: "Use the target default.",
    });

    expect(result.model).toBe("default-model");
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
        status: "running",
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
    expect(result.lastActivityAt).toBeDefined();
    expect(result.stalled).toBe(false);
  }),
);

it.effect("returns canonical tracked activity for timed-out stalled sub-agents", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();
    const spawned = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("codex"),
      prompt: "Wedged task.",
    });
    harness.setThreadDetail((threadId) =>
      threadId === spawned.threadId
        ? Option.some(makeThreadDetail(spawned.threadId, { latestTurn: null }))
        : Option.none(),
    );
    harness.setSessionActivity((threadId) =>
      threadId === spawned.threadId
        ? { lastActivityAt: "1960-01-01T00:00:00.000Z", stalled: true }
        : undefined,
    );

    const waiting = yield* coordinator
      .wait(makeScope(), { threadId: spawned.threadId, timeoutSeconds: 1 })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.seconds(2));
    const result = yield* Fiber.join(waiting);
    expect(result.status).toBe("running");
    expect(result.lastActivityAt).toBe("1960-01-01T00:00:00.000Z");
    expect(result.stalled).toBe(true);
  }),
);

it.effect("uses the Effect clock for fallback stall detection", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe("2026-04-11T00:00:00.000Z")),
    );
    const [coordinator, harness] = yield* makeCoordinator();
    const spawned = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("codex"),
      prompt: "Slow task without tracked activity.",
    });
    harness.setThreadDetail((threadId) =>
      threadId === spawned.threadId
        ? Option.some(makeThreadDetail(spawned.threadId, { latestTurn: null }))
        : Option.none(),
    );

    const waiting = yield* coordinator
      .wait(makeScope(), { threadId: spawned.threadId, timeoutSeconds: 121 })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.seconds(122));
    const result = yield* Fiber.join(waiting);

    expect(result.status).toBe("running");
    expect(result.lastActivityAt).toBe("2026-04-11T00:00:00.000Z");
    expect(result.stalled).toBe(true);
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

const completedTurnDetail = (threadId: ThreadId) => {
  const assistantMessageId = MessageId.make("assistant-message-completed");
  const turnId = TurnId.make("turn-completed");
  return makeThreadDetail(threadId, {
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
        text: "Done.",
        turnId,
        streaming: false,
        createdAt: "9999-01-01T00:00:01.000Z",
        updatedAt: "9999-01-01T00:00:01.000Z",
      },
    ],
  });
};

it.effect("truncates name-driven Agent: titles at the title cap", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();
    const longName = "x".repeat(80);

    const result = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("codex"),
      prompt: "Work.",
      name: longName,
    });

    expect(result.title.length).toBe(__testing.DEFAULT_TITLE_MAX_LENGTH);
    expect(result.title.endsWith("…")).toBe(true);
    expect(result.title.startsWith("Agent: ")).toBe(true);

    const create = harness.dispatched.find((command) => command.type === "thread.create");
    if (create?.type === "thread.create") {
      expect(create.title).toBe(result.title);
      expect(create.title.length).toBe(__testing.DEFAULT_TITLE_MAX_LENGTH);
    }
  }),
);

it.effect("sanitizes control characters and whitespace runs in agent names", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();

    const result = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("codex"),
      prompt: "Work.",
      name: "pay\nments\t  auditor\u0000bot",
    });

    expect(result.name).toBe("pay ments auditor bot");
    expect(result.title).toBe("Agent: pay ments auditor bot");

    const create = harness.dispatched.find((command) => command.type === "thread.create");
    if (create?.type === "thread.create") {
      expect(create.title).toBe("Agent: pay ments auditor bot");
      expect(create.title).not.toMatch(/[\n\t\u0000]/);
    }

    const listed = yield* coordinator.list(makeScope());
    expect(listed.agents[0]?.name).toBe("pay ments auditor bot");
  }),
);

it.effect("lists a completed agent with its terminal status", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();

    const spawned = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("codex"),
      prompt: "Finish quickly.",
      name: "finisher",
    });

    harness.setThreadDetail((threadId) =>
      threadId === spawned.threadId
        ? Option.some(completedTurnDetail(spawned.threadId))
        : Option.none(),
    );

    // First wait observes completion and records terminal status.
    const waited = yield* coordinator.wait(makeScope(), {
      threadId: spawned.threadId,
      timeoutSeconds: 5,
    });
    expect(waited.status).toBe("completed");

    const listed = yield* coordinator.list(makeScope());
    expect(listed.agents).toEqual([
      {
        threadId: spawned.threadId,
        name: "finisher",
        title: "Agent: finisher",
        providerInstanceId: "codex",
        model: "default-model",
        status: "completed",
      },
    ]);
  }),
);

it.effect("refuses send while running and wait on an already-terminal handle", () =>
  Effect.gen(function* () {
    const [coordinator, harness] = yield* makeCoordinator();

    const spawned = yield* coordinator.spawn(makeScope(), {
      providerInstanceId: ProviderInstanceId.make("codex"),
      prompt: "Long task.",
    });

    // Still running (no latest turn yet) — send must refuse.
    harness.setThreadDetail((threadId) =>
      threadId === spawned.threadId
        ? Option.some(makeThreadDetail(spawned.threadId, { latestTurn: null }))
        : Option.none(),
    );

    const sendWhileRunning = yield* expectSubAgentError(
      coordinator.send(makeScope(), {
        threadId: spawned.threadId,
        prompt: "Also do this.",
      }),
    );
    expect(sendWhileRunning.reason).toBe("invalid-status");
    expect(sendWhileRunning.description).toMatch(/still running/i);
    expect(sendWhileRunning.description).toMatch(/status: running/);

    // Complete the turn, wait once (records terminal), then refuse a second wait.
    harness.setThreadDetail((threadId) =>
      threadId === spawned.threadId
        ? Option.some(completedTurnDetail(spawned.threadId))
        : Option.none(),
    );
    const firstWait = yield* coordinator.wait(makeScope(), {
      threadId: spawned.threadId,
      timeoutSeconds: 5,
    });
    expect(firstWait.status).toBe("completed");

    const waitWhenTerminal = yield* expectSubAgentError(
      coordinator.wait(makeScope(), { threadId: spawned.threadId, timeoutSeconds: 5 }),
    );
    expect(waitWhenTerminal.reason).toBe("invalid-status");
    expect(waitWhenTerminal.description).toMatch(/not running/i);
    expect(waitWhenTerminal.description).toMatch(/status: completed/);

    // Follow-up send after terminal is allowed (starts a new turn).
    const sent = yield* coordinator.send(makeScope(), {
      threadId: spawned.threadId,
      prompt: "One more thing.",
    });
    expect(sent.status).toBe("running");
  }),
);

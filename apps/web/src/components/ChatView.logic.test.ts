import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EnvironmentState, useStore } from "../store";
import { type Thread } from "../types";

import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildExpiredTerminalContextToastCopy,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  hasServerAcknowledgedLocalDispatch,
  reconcileMountedTerminalThreadIds,
  shouldWriteThreadErrorToCurrentServerThread,
  waitForStartedServerThread,
} from "./ChatView.logic";

const localEnvironmentId = EnvironmentId.makeUnsafe("environment-local");

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps previously mounted open threads and adds the active open thread", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.makeUnsafe("thread-hidden"),
          ThreadId.makeUnsafe("thread-stale"),
        ],
        openThreadIds: [ThreadId.makeUnsafe("thread-hidden"), ThreadId.makeUnsafe("thread-active")],
        activeThreadId: ThreadId.makeUnsafe("thread-active"),
        activeThreadTerminalOpen: true,
      }),
    ).toEqual([ThreadId.makeUnsafe("thread-hidden"), ThreadId.makeUnsafe("thread-active")]);
  });

  it("drops mounted threads once their terminal drawer is no longer open", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [ThreadId.makeUnsafe("thread-closed")],
        openThreadIds: [],
        activeThreadId: ThreadId.makeUnsafe("thread-closed"),
        activeThreadTerminalOpen: false,
      }),
    ).toEqual([]);
  });

  it("keeps only the most recently active hidden terminal threads", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
        ],
        openThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
          ThreadId.makeUnsafe("thread-4"),
        ],
        activeThreadId: ThreadId.makeUnsafe("thread-4"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-4"),
    ]);
  });

  it("moves the active thread to the end so it is treated as most recently used", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.makeUnsafe("thread-a"),
          ThreadId.makeUnsafe("thread-b"),
          ThreadId.makeUnsafe("thread-c"),
        ],
        openThreadIds: [
          ThreadId.makeUnsafe("thread-a"),
          ThreadId.makeUnsafe("thread-b"),
          ThreadId.makeUnsafe("thread-c"),
        ],
        activeThreadId: ThreadId.makeUnsafe("thread-a"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([
      ThreadId.makeUnsafe("thread-b"),
      ThreadId.makeUnsafe("thread-c"),
      ThreadId.makeUnsafe("thread-a"),
    ]);
  });

  it("defaults to the hidden mounted terminal cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => ThreadId.makeUnsafe(`thread-${index + 1}`),
    );

    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("routes errors to the active server thread when route and target match", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const routeThreadRef = scopeThreadRef(localEnvironmentId, threadId);

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: {
          environmentId: localEnvironmentId,
          id: threadId,
        },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
  });

  it("does not route draft-thread errors into server-backed state", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: undefined,
        routeThreadRef: scopeThreadRef(localEnvironmentId, threadId),
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

const makeThread = (input?: {
  id?: ThreadId;
  latestTurn?: {
    turnId: TurnId;
    state: "running" | "completed";
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
}): Thread => ({
  id: input?.id ?? ThreadId.makeUnsafe("thread-1"),
  environmentId: localEnvironmentId,
  codexThreadId: null,
  projectId: ProjectId.makeUnsafe("project-1"),
  title: "Thread",
  modelSelection: { provider: "codex" as const, model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  session: null,
  messages: [],
  proposedPlans: [],
  error: null,
  createdAt: "2026-03-29T00:00:00.000Z",
  archivedAt: null,
  updatedAt: "2026-03-29T00:00:00.000Z",
  latestTurn: input?.latestTurn
    ? {
        ...input.latestTurn,
        assistantMessageId: null,
      }
    : null,
  branch: null,
  worktreePath: null,
  turnDiffSummaries: [],
  activities: [],
});

function setStoreThreads(threads: ReadonlyArray<ReturnType<typeof makeThread>>) {
  const projectId = ProjectId.makeUnsafe("project-1");
  const environmentState: EnvironmentState = {
    projectIds: [projectId],
    projectById: {
      [projectId]: {
        id: projectId,
        environmentId: localEnvironmentId,
        name: "Project",
        cwd: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        createdAt: "2026-03-29T00:00:00.000Z",
        updatedAt: "2026-03-29T00:00:00.000Z",
        scripts: [],
      },
    },
    threadIds: threads.map((thread) => thread.id),
    threadIdsByProjectId: {
      [projectId]: threads.map((thread) => thread.id),
    },
    threadShellById: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        {
          id: thread.id,
          environmentId: thread.environmentId,
          codexThreadId: thread.codexThreadId,
          projectId: thread.projectId,
          title: thread.title,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          error: thread.error,
          createdAt: thread.createdAt,
          archivedAt: thread.archivedAt,
          updatedAt: thread.updatedAt,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        },
      ]),
    ),
    threadSessionById: Object.fromEntries(threads.map((thread) => [thread.id, thread.session])),
    threadTurnStateById: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        {
          latestTurn: thread.latestTurn,
          ...(thread.pendingSourceProposedPlan
            ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
            : {}),
        },
      ]),
    ),
    messageIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.messages.map((message) => message.id)]),
    ),
    messageByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.messages.map((message) => [message.id, message])),
      ]),
    ),
    activityIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.activities.map((activity) => activity.id)]),
    ),
    activityByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.activities.map((activity) => [activity.id, activity])),
      ]),
    ),
    proposedPlanIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.proposedPlans.map((plan) => plan.id)]),
    ),
    proposedPlanByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.proposedPlans.map((plan) => [plan.id, plan])),
      ]),
    ),
    turnDiffIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        thread.turnDiffSummaries.map((summary) => summary.turnId),
      ]),
    ),
    turnDiffSummaryByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.turnDiffSummaries.map((summary) => [summary.turnId, summary])),
      ]),
    ),
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  useStore.setState({
    activeEnvironmentId: localEnvironmentId,
    environmentStateById: {
      [localEnvironmentId]: environmentState,
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setStoreThreads([]);
});

describe("waitForStartedServerThread", () => {
  it("resolves immediately when the thread is already started", async () => {
    const threadId = ThreadId.makeUnsafe("thread-started");
    setStoreThreads([
      makeThread({
        id: threadId,
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-started"),
          state: "running",
          requestedAt: "2026-03-29T00:00:01.000Z",
          startedAt: "2026-03-29T00:00:01.000Z",
          completedAt: null,
        },
      }),
    ]);

    await expect(
      waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId)),
    ).resolves.toBe(true);
  });

  it("waits for the thread to start via subscription updates", async () => {
    const threadId = ThreadId.makeUnsafe("thread-wait");
    setStoreThreads([makeThread({ id: threadId })]);

    const promise = waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500);

    setStoreThreads([
      makeThread({
        id: threadId,
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-started"),
          state: "running",
          requestedAt: "2026-03-29T00:00:01.000Z",
          startedAt: "2026-03-29T00:00:01.000Z",
          completedAt: null,
        },
      }),
    ]);

    await expect(promise).resolves.toBe(true);
  });

  it("handles the thread starting between the initial read and subscription setup", async () => {
    const threadId = ThreadId.makeUnsafe("thread-race");
    setStoreThreads([makeThread({ id: threadId })]);

    const originalSubscribe = useStore.subscribe.bind(useStore);
    let raced = false;
    vi.spyOn(useStore, "subscribe").mockImplementation((listener) => {
      if (!raced) {
        raced = true;
        setStoreThreads([
          makeThread({
            id: threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-race"),
              state: "running",
              requestedAt: "2026-03-29T00:00:01.000Z",
              startedAt: "2026-03-29T00:00:01.000Z",
              completedAt: null,
            },
          }),
        ]);
      }
      return originalSubscribe(listener);
    });

    await expect(
      waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500),
    ).resolves.toBe(true);
  });

  it("returns false after the timeout when the thread never starts", async () => {
    vi.useFakeTimers();

    const threadId = ThreadId.makeUnsafe("thread-timeout");
    setStoreThreads([makeThread({ id: threadId })]);
    const promise = waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500);

    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  const projectId = ProjectId.makeUnsafe("project-1");
  const previousLatestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-03-29T00:00:00.000Z",
    startedAt: "2026-03-29T00:00:01.000Z",
    completedAt: "2026-03-29T00:00:10.000Z",
    assistantMessageId: null,
  };

  const previousSession = {
    provider: "codex" as const,
    status: "ready" as const,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:10.000Z",
    orchestrationStatus: "idle" as const,
  };

  it("does not clear local dispatch before server state changes", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.makeUnsafe("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: previousSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("clears local dispatch when a new turn is already settled", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.makeUnsafe("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: {
          ...previousLatestTurn,
          turnId: TurnId.makeUnsafe("turn-2"),
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: "2026-03-29T00:01:30.000Z",
        },
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:01:30.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("clears local dispatch when the session changes without an observed running phase", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.makeUnsafe("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:00:11.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});

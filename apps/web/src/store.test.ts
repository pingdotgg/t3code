import {
  CheckpointRef,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  selectProjects,
  selectThreads,
  syncServerReadModel,
  type AppState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  const projectId = ProjectId.makeUnsafe("project-1");
  const project = {
    id: projectId,
    name: "Project",
    cwd: "/tmp/project",
    defaultModelSelection: {
      provider: "codex" as const,
      model: "gpt-5-codex",
    },
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    scripts: [],
  };
  const threadIdsByProjectId: AppState["threadIdsByProjectId"] = {
    [thread.projectId]: [thread.id],
  };
  return {
    projectIds: [projectId],
    projectById: {
      [projectId]: project,
    },
    threadIds: [thread.id],
    threadIdsByProjectId,
    threadShellById: {
      [thread.id]: {
        id: thread.id,
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
    },
    threadSessionById: {
      [thread.id]: thread.session,
    },
    threadTurnStateById: {
      [thread.id]: {
        latestTurn: thread.latestTurn,
        ...(thread.pendingSourceProposedPlan
          ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
          : {}),
      },
    },
    messageIdsByThreadId: {
      [thread.id]: thread.messages.map((message) => message.id),
    },
    messageByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.messages.map((message) => [message.id, message] as const),
      ) as AppState["messageByThreadId"][ThreadId],
    },
    activityIdsByThreadId: {
      [thread.id]: thread.activities.map((activity) => activity.id),
    },
    activityByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.activities.map((activity) => [activity.id, activity] as const),
      ) as AppState["activityByThreadId"][ThreadId],
    },
    proposedPlanIdsByThreadId: {
      [thread.id]: thread.proposedPlans.map((plan) => plan.id),
    },
    proposedPlanByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.proposedPlans.map((plan) => [plan.id, plan] as const),
      ) as AppState["proposedPlanByThreadId"][ThreadId],
    },
    turnDiffIdsByThreadId: {
      [thread.id]: thread.turnDiffSummaries.map((summary) => summary.turnId),
    },
    turnDiffSummaryByThreadId: {
      [thread.id]: Object.fromEntries(
        thread.turnDiffSummaries.map((summary) => [summary.turnId, summary] as const),
      ) as AppState["turnDiffSummaryByThreadId"][ThreadId],
    },
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
}

function makeEmptyState(overrides: Partial<AppState> = {}): AppState {
  return {
    projectIds: [],
    projectById: {},
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
    ...overrides,
  };
}

function projectsOf(state: AppState) {
  return selectProjects(state);
}

function threadsOf(state: AppState) {
  return selectThreads(state);
}

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.makeUnsafe("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
    ...overrides,
  };
}

describe("store read model sync", () => {
  it("marks bootstrap complete after snapshot sync", () => {
    const initialState: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = syncServerReadModel(initialState, makeReadModel(makeReadModelThread({})));

    expect(next.bootstrapComplete).toBe(true);
  });

  it("preserves claude model slugs without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(threadsOf(next)[0]?.modelSelection.model).toBe("claude-opus-4-6");
  });

  it("resolves claude aliases when session provider is claudeAgent", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "sonnet",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(threadsOf(next)[0]?.modelSelection.model).toBe("claude-sonnet-4-6");
  });

  it("preserves project and thread updatedAt timestamps from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(projectsOf(next)[0]?.updatedAt).toBe("2026-02-27T00:00:00.000Z");
    expect(threadsOf(next)[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("maps archivedAt from the read model", () => {
    const initialState = makeState(makeThread());
    const archivedAt = "2026-02-28T00:00:00.000Z";
    const next = syncServerReadModel(
      initialState,
      makeReadModel(
        makeReadModelThread({
          archivedAt,
        }),
      ),
    );

    expect(threadsOf(next)[0]?.archivedAt).toBe(archivedAt);
  });

  it("replaces projects using snapshot order during recovery", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = makeEmptyState({
      projectIds: [project2, project1],
      projectById: {
        [project2]: {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
        [project1]: {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
      },
    });
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(projectsOf(next).map((project) => project.id)).toEqual([project1, project2, project3]);
  });
});

describe("incremental orchestration updates", () => {
  it("does not mark bootstrap complete for incremental events", () => {
    const state: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.bootstrapComplete).toBe(false);
  });

  it("updates the existing project title when project.meta-updated arrives", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const state = makeState(
      makeThread({
        projectId,
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.meta-updated", {
        projectId,
        title: "Renamed Project",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projectById[projectId]?.name).toBe("Renamed Project");
    expect(next.projectById[projectId]?.updatedAt).toBe("2026-02-27T00:00:01.000Z");
  });

  it("preserves state identity for no-op project and thread deletes", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const nextAfterProjectDelete = applyOrchestrationEvent(
      state,
      makeEvent("project.deleted", {
        projectId: ProjectId.makeUnsafe("project-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    const nextAfterThreadDelete = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: ThreadId.makeUnsafe("thread-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(nextAfterProjectDelete).toBe(state);
    expect(nextAfterThreadDelete).toBe(state);
  });

  it("reuses an existing project row when project.created arrives with a new id for the same cwd", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const state: AppState = makeEmptyState({
      projectIds: [originalProjectId],
      projectById: {
        [originalProjectId]: {
          id: originalProjectId,
          name: "Project",
          cwd: "/tmp/project",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: recreatedProjectId,
        title: "Project Recreated",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(projectsOf(next)).toHaveLength(1);
    expect(projectsOf(next)[0]?.id).toBe(recreatedProjectId);
    expect(projectsOf(next)[0]?.cwd).toBe("/tmp/project");
    expect(projectsOf(next)[0]?.name).toBe("Project Recreated");
    expect(next.projectIds).toEqual([recreatedProjectId]);
    expect(next.projectById[originalProjectId]).toBeUndefined();
    expect(next.projectById[recreatedProjectId]?.id).toBe(recreatedProjectId);
  });

  it("removes stale project index entries when thread.created recreates a thread under a new project", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const thread = makeThread({
      id: threadId,
      projectId: originalProjectId,
    });
    const state: AppState = {
      ...makeState(thread),
      projectIds: [originalProjectId, recreatedProjectId],
      projectById: {
        [originalProjectId]: {
          id: originalProjectId,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
        [recreatedProjectId]: {
          id: recreatedProjectId,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
          scripts: [],
        },
      },
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId: recreatedProjectId,
        title: "Recovered thread",
        modelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(threadsOf(next)).toHaveLength(1);
    expect(threadsOf(next)[0]?.projectId).toBe(recreatedProjectId);
    expect(next.threadIdsByProjectId[originalProjectId]).toBeUndefined();
    expect(next.threadIdsByProjectId[recreatedProjectId]).toEqual([threadId]);
  });

  it("updates only the affected thread for message events", () => {
    const thread1 = makeThread({
      id: ThreadId.makeUnsafe("thread-1"),
      messages: [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:00.000Z",
          streaming: false,
        },
      ],
    });
    const thread2 = makeThread({ id: ThreadId.makeUnsafe("thread-2") });
    const state: AppState = {
      ...makeState(thread1),
      threadIds: [thread1.id, thread2.id],
      threadShellById: {
        ...makeState(thread1).threadShellById,
        [thread2.id]: {
          id: thread2.id,
          codexThreadId: thread2.codexThreadId,
          projectId: thread2.projectId,
          title: thread2.title,
          modelSelection: thread2.modelSelection,
          runtimeMode: thread2.runtimeMode,
          interactionMode: thread2.interactionMode,
          error: thread2.error,
          createdAt: thread2.createdAt,
          archivedAt: thread2.archivedAt,
          updatedAt: thread2.updatedAt,
          branch: thread2.branch,
          worktreePath: thread2.worktreePath,
        },
      },
      threadSessionById: {
        ...makeState(thread1).threadSessionById,
        [thread2.id]: thread2.session,
      },
      threadTurnStateById: {
        ...makeState(thread1).threadTurnStateById,
        [thread2.id]: {
          latestTurn: thread2.latestTurn,
        },
      },
      messageIdsByThreadId: {
        ...makeState(thread1).messageIdsByThreadId,
        [thread2.id]: [],
      },
      messageByThreadId: {
        ...makeState(thread1).messageByThreadId,
        [thread2.id]: {},
      },
      activityIdsByThreadId: {
        ...makeState(thread1).activityIdsByThreadId,
        [thread2.id]: [],
      },
      activityByThreadId: {
        ...makeState(thread1).activityByThreadId,
        [thread2.id]: {},
      },
      proposedPlanIdsByThreadId: {
        ...makeState(thread1).proposedPlanIdsByThreadId,
        [thread2.id]: [],
      },
      proposedPlanByThreadId: {
        ...makeState(thread1).proposedPlanByThreadId,
        [thread2.id]: {},
      },
      turnDiffIdsByThreadId: {
        ...makeState(thread1).turnDiffIdsByThreadId,
        [thread2.id]: [],
      },
      turnDiffSummaryByThreadId: {
        ...makeState(thread1).turnDiffSummaryByThreadId,
        [thread2.id]: {},
      },
      sidebarThreadSummaryById: {
        ...makeState(thread1).sidebarThreadSummaryById,
      },
      threadIdsByProjectId: {
        [thread1.projectId]: [thread1.id, thread2.id],
      },
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread1.id,
        messageId: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: " world",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(threadsOf(next)[0]?.messages[0]?.text).toBe("hello world");
    expect(threadsOf(next)[0]?.latestTurn?.state).toBe("running");
    expect(next.threadShellById[thread2.id]).toBe(state.threadShellById[thread2.id]);
    expect(next.threadSessionById[thread2.id]).toBe(state.threadSessionById[thread2.id]);
    expect(next.messageIdsByThreadId[thread2.id]).toBe(state.messageIdsByThreadId[thread2.id]);
    expect(next.messageByThreadId[thread2.id]).toBe(state.messageByThreadId[thread2.id]);
  });

  it("applies replay batches in sequence and updates session state", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvents(state, [
      makeEvent(
        "thread.session-set",
        {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.makeUnsafe("turn-1"),
            lastError: null,
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        },
        { sequence: 2 },
      ),
      makeEvent(
        "thread.message-sent",
        {
          threadId: thread.id,
          messageId: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "done",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-02-27T00:00:03.000Z",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
        { sequence: 3 },
      ),
    ]);

    expect(threadsOf(next)[0]?.session?.status).toBe("running");
    expect(threadsOf(next)[0]?.latestTurn?.state).toBe("completed");
    expect(threadsOf(next)[0]?.messages).toHaveLength(1);
  });

  it("does not regress latestTurn when an older turn diff completes late", () => {
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "running",
          requestedAt: "2026-02-27T00:00:02.000Z",
          startedAt: "2026-02-27T00:00:03.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
    );

    expect(threadsOf(next)[0]?.turnDiffSummaries).toHaveLength(1);
    expect(threadsOf(next)[0]?.latestTurn).toEqual(threadsOf(state)[0]?.latestTurn);
  });

  it("rebinds live turn diffs to the authoritative assistant message when it arrives later", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
        },
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:02.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
            assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
            files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("assistant-real"),
        role: "assistant",
        text: "final answer",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    );

    expect(threadsOf(next)[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
    expect(threadsOf(next)[0]?.latestTurn?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
  });

  it("reverts messages, plans, activities, and checkpoints by retained turns", () => {
    const state = makeState(
      makeThread({
        messages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            text: "first",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            completedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "first reply",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:01.000Z",
            completedAt: "2026-02-27T00:00:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("user-2"),
            role: "user",
            text: "second",
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
            completedAt: "2026-02-27T00:00:02.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "plan 1",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: "plan-2",
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "plan 2",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:02.000Z",
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-1"),
            tone: "info",
            kind: "step",
            summary: "one",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: EventId.makeUnsafe("activity-2"),
            tone: "info",
            kind: "step",
            summary: "two",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-1"),
            completedAt: "2026-02-27T00:00:01.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
            files: [],
          },
          {
            turnId: TurnId.makeUnsafe("turn-2"),
            completedAt: "2026-02-27T00:00:03.000Z",
            status: "ready",
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
            files: [],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
      }),
    );

    expect(threadsOf(next)[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(threadsOf(next)[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(threadsOf(next)[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("activity-1"),
    ]);
    expect(threadsOf(next)[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.makeUnsafe("turn-1"),
    ]);
  });

  it("clears pending source proposed plans after revert before a new session-set event", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-2"),
        state: "completed",
        requestedAt: "2026-02-27T00:00:02.000Z",
        startedAt: "2026-02-27T00:00:02.000Z",
        completedAt: "2026-02-27T00:00:03.000Z",
        assistantMessageId: MessageId.makeUnsafe("assistant-2"),
        sourceProposedPlan: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          planId: "plan-2" as never,
        },
      },
      pendingSourceProposedPlan: {
        threadId: ThreadId.makeUnsafe("thread-source"),
        planId: "plan-2" as never,
      },
      turnDiffSummaries: [
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          completedAt: "2026-02-27T00:00:01.000Z",
          status: "ready",
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
          files: [],
        },
        {
          turnId: TurnId.makeUnsafe("turn-2"),
          completedAt: "2026-02-27T00:00:03.000Z",
          status: "ready",
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
          files: [],
        },
      ],
    });
    const reverted = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.reverted", {
        threadId: thread.id,
        turnCount: 1,
      }),
    );

    expect(threadsOf(reverted)[0]?.pendingSourceProposedPlan).toBeUndefined();

    const next = applyOrchestrationEvent(
      reverted,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-3"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:04.000Z",
        },
      }),
    );

    expect(threadsOf(next)[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-3"),
      state: "running",
    });
    expect(threadsOf(next)[0]?.latestTurn?.sourceProposedPlan).toBeUndefined();
  });
});

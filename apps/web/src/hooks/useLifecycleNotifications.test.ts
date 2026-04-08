import {
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { collectLifecycleNotifications } from "../lifecycleNotifications";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-03-30T10:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
  };
}

function makeThread(
  overrides: Partial<
    Parameters<typeof collectLifecycleNotifications>[0]["nextThreads"][number]
  > = {},
) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Review auth flow",
    activities: [],
    latestTurn: null,
    session: null,
    ...overrides,
  };
}

const projects = [{ id: ProjectId.makeUnsafe("project-1"), name: "t3code" }];

describe("collectLifecycleNotifications", () => {
  it("emits a completion notification when a turn newly settles", () => {
    const notifications = collectLifecycleNotifications({
      previousThreads: [
        makeThread({
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-1"),
            state: "running",
            requestedAt: "2026-03-30T10:00:00.000Z",
            startedAt: "2026-03-30T10:00:01.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-03-30T10:00:00.000Z",
            updatedAt: "2026-03-30T10:00:02.000Z",
            orchestrationStatus: "running",
            activeTurnId: TurnId.makeUnsafe("turn-1"),
          },
        }),
      ],
      nextThreads: [
        makeThread({
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-1"),
            state: "completed",
            requestedAt: "2026-03-30T10:00:00.000Z",
            startedAt: "2026-03-30T10:00:01.000Z",
            completedAt: "2026-03-30T10:00:05.000Z",
            assistantMessageId: null,
          },
          session: {
            provider: "codex",
            status: "ready",
            createdAt: "2026-03-30T10:00:00.000Z",
            updatedAt: "2026-03-30T10:00:05.000Z",
            orchestrationStatus: "ready",
            activeTurnId: undefined,
          },
        }),
      ],
      projects,
    });

    expect(notifications).toEqual([
      {
        id: "turn-completed:thread-1:turn-1:2026-03-30T10:00:05.000Z",
        kind: "turn-completed",
        title: "Turn completed",
        body: "Agent finished work in t3code · Review auth flow.",
        threadId: ThreadId.makeUnsafe("thread-1"),
      },
    ]);
  });

  it("emits an attention notification for a newly requested user input", () => {
    const notifications = collectLifecycleNotifications({
      previousThreads: [makeThread()],
      nextThreads: [
        makeThread({
          activities: [
            makeActivity({
              id: "evt-user-input",
              kind: "user-input.requested",
              summary: "Need clarification",
              tone: "approval",
              payload: {
                requestId: "req-user-1",
                questions: [
                  {
                    id: "q-1",
                    header: "Clarify",
                    question: "Which branch should I use?",
                    options: [{ label: "main", description: "Use main" }],
                  },
                ],
              },
            }),
          ],
        }),
      ],
      projects,
    });

    expect(notifications[0]).toMatchObject({
      id: "user-input:thread-1:req-user-1",
      kind: "user-input-requested",
      title: "Input needed",
      body: "Agent is waiting for your input in t3code · Review auth flow.",
    });
  });

  it("emits an attention notification for a newly requested approval", () => {
    const notifications = collectLifecycleNotifications({
      previousThreads: [makeThread()],
      nextThreads: [
        makeThread({
          activities: [
            makeActivity({
              id: "evt-approval",
              kind: "approval.requested",
              summary: "Command approval requested",
              tone: "approval",
              payload: {
                requestId: "req-approval-1",
                requestKind: "command",
                detail: "bun run lint",
              },
            }),
          ],
        }),
      ],
      projects,
    });

    expect(notifications[0]).toMatchObject({
      id: "approval:thread-1:req-approval-1",
      kind: "approval-requested",
      title: "Approval needed",
      body: "Agent needs approval in t3code · Review auth flow.",
    });
  });

  it("does not duplicate a completion that was already observed", () => {
    const completedThread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "completed",
        requestedAt: "2026-03-30T10:00:00.000Z",
        startedAt: "2026-03-30T10:00:01.000Z",
        completedAt: "2026-03-30T10:00:05.000Z",
        assistantMessageId: null,
      },
      session: {
        provider: "codex",
        status: "ready",
        createdAt: "2026-03-30T10:00:00.000Z",
        updatedAt: "2026-03-30T10:00:05.000Z",
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      },
    });

    const notifications = collectLifecycleNotifications({
      previousThreads: [completedThread],
      nextThreads: [completedThread],
      projects,
    });

    expect(notifications).toEqual([]);
  });

  it("prioritizes pending attention requests over completion notifications", () => {
    const notifications = collectLifecycleNotifications({
      previousThreads: [
        makeThread({
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-1"),
            state: "running",
            requestedAt: "2026-03-30T10:00:00.000Z",
            startedAt: "2026-03-30T10:00:01.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-03-30T10:00:00.000Z",
            updatedAt: "2026-03-30T10:00:02.000Z",
            orchestrationStatus: "running",
            activeTurnId: TurnId.makeUnsafe("turn-1"),
          },
        }),
      ],
      nextThreads: [
        makeThread({
          activities: [
            makeActivity({
              id: "evt-approval",
              kind: "approval.requested",
              summary: "Command approval requested",
              tone: "approval",
              payload: {
                requestId: "req-approval-1",
                requestKind: "command",
                detail: "bun run lint",
              },
            }),
          ],
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-1"),
            state: "completed",
            requestedAt: "2026-03-30T10:00:00.000Z",
            startedAt: "2026-03-30T10:00:01.000Z",
            completedAt: "2026-03-30T10:00:05.000Z",
            assistantMessageId: null,
          },
          session: {
            provider: "codex",
            status: "ready",
            createdAt: "2026-03-30T10:00:00.000Z",
            updatedAt: "2026-03-30T10:00:05.000Z",
            orchestrationStatus: "ready",
            activeTurnId: undefined,
          },
        }),
      ],
      projects,
    });

    expect(notifications).toEqual([
      {
        id: "approval:thread-1:req-approval-1",
        kind: "approval-requested",
        title: "Approval needed",
        body: "Agent needs approval in t3code · Review auth flow.",
        threadId: ThreadId.makeUnsafe("thread-1"),
      },
    ]);
  });
});

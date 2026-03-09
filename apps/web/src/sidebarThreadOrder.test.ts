import { describe, expect, it } from "vitest";

import { sortSidebarThreadEntries } from "./sidebarThreadOrder";
import { type Thread } from "./types";

function makeThread(overrides: Partial<Thread>): Thread {
  return {
    id: "thread" as Thread["id"],
    codexThreadId: null,
    projectId: "project" as Thread["projectId"],
    title: "Thread",
    model: "gpt-5.4",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T12:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

describe("sortSidebarThreadEntries", () => {
  it("sorts by recent activity when configured", () => {
    const olderThread = makeThread({
      id: "thread-older" as Thread["id"],
      createdAt: "2026-03-09T11:00:00.000Z",
      messages: [
        {
          id: "older-user" as Thread["messages"][number]["id"],
          role: "user",
          text: "hello",
          streaming: false,
          createdAt: "2026-03-09T11:01:00.000Z",
        },
      ],
    });
    const newerActivityThread = makeThread({
      id: "thread-new-activity" as Thread["id"],
      createdAt: "2026-03-09T10:00:00.000Z",
      messages: [
        {
          id: "new-user" as Thread["messages"][number]["id"],
          role: "user",
          text: "latest",
          streaming: false,
          createdAt: "2026-03-09T12:30:00.000Z",
        },
      ],
    });

    const ordered = sortSidebarThreadEntries(
      [
        { id: olderThread.id, createdAt: olderThread.createdAt, thread: olderThread },
        {
          id: newerActivityThread.id,
          createdAt: newerActivityThread.createdAt,
          thread: newerActivityThread,
        },
      ],
      "recent-activity",
    );

    expect(ordered.map((entry) => entry.id)).toEqual([
      newerActivityThread.id,
      olderThread.id,
    ]);
  });

  it("sorts by created-at when configured", () => {
    const olderThread = makeThread({
      id: "thread-older" as Thread["id"],
      createdAt: "2026-03-09T11:00:00.000Z",
      messages: [
        {
          id: "older-user" as Thread["messages"][number]["id"],
          role: "user",
          text: "latest",
          streaming: false,
          createdAt: "2026-03-09T12:30:00.000Z",
        },
      ],
    });
    const newerThread = makeThread({
      id: "thread-newer" as Thread["id"],
      createdAt: "2026-03-09T12:00:00.000Z",
    });

    const ordered = sortSidebarThreadEntries(
      [
        { id: olderThread.id, createdAt: olderThread.createdAt, thread: olderThread },
        { id: newerThread.id, createdAt: newerThread.createdAt, thread: newerThread },
      ],
      "created-at",
    );

    expect(ordered.map((entry) => entry.id)).toEqual([newerThread.id, olderThread.id]);
  });

  it("treats proposed plans and pending questions as recent activity", () => {
    const planThread = makeThread({
      id: "thread-plan" as Thread["id"],
      createdAt: "2026-03-09T08:00:00.000Z",
      proposedPlans: [
        {
          id: "plan-1" as Thread["proposedPlans"][number]["id"],
          turnId: null,
          planMarkdown: "# plan",
          createdAt: "2026-03-09T09:00:00.000Z",
          updatedAt: "2026-03-09T12:15:00.000Z",
        },
      ],
    });
    const questionThread = makeThread({
      id: "thread-question" as Thread["id"],
      createdAt: "2026-03-09T07:00:00.000Z",
      activities: [
        {
          id: "act-1" as Thread["activities"][number]["id"],
          createdAt: "2026-03-09T12:20:00.000Z",
          kind: "user-input.requested",
          summary: "Need input",
          tone: "info",
          payload: {
            requestId: "req-1",
            questions: [
              {
                id: "answer",
                header: "Answer",
                question: "Need input",
                options: [
                  {
                    label: "continue",
                    description: "Continue execution",
                  },
                ],
              },
            ],
          },
          turnId: null,
          sequence: 1,
        },
      ],
    });

    const ordered = sortSidebarThreadEntries(
      [
        { id: planThread.id, createdAt: planThread.createdAt, thread: planThread },
        { id: questionThread.id, createdAt: questionThread.createdAt, thread: questionThread },
      ],
      "recent-activity",
    );

    expect(ordered.map((entry) => entry.id)).toEqual([questionThread.id, planThread.id]);
  });
});

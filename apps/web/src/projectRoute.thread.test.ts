import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { resolveThreadRouteTarget } from "./projectRoute";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides?: Partial<Thread>): Thread {
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
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("resolveThreadRouteTarget", () => {
  it("returns a server thread project id", () => {
    expect(
      resolveThreadRouteTarget({
        threadId: ThreadId.makeUnsafe("thread-1"),
        threads: [makeThread()],
        draftThreadsByThreadId: {},
      }),
    ).toEqual({
      kind: "thread",
      projectId: ProjectId.makeUnsafe("project-1"),
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
  });

  it("returns a draft thread project id", () => {
    expect(
      resolveThreadRouteTarget({
        threadId: ThreadId.makeUnsafe("draft-thread"),
        threads: [],
        draftThreadsByThreadId: {
          [ThreadId.makeUnsafe("draft-thread")]: {
            projectId: ProjectId.makeUnsafe("project-2"),
            createdAt: "2026-03-28T10:00:00.000Z",
            branch: null,
            worktreePath: null,
            envMode: "local",
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
          },
        },
      }),
    ).toEqual({
      kind: "thread",
      projectId: ProjectId.makeUnsafe("project-2"),
      threadId: ThreadId.makeUnsafe("draft-thread"),
    });
  });

  it("returns missing when the thread cannot be resolved", () => {
    expect(
      resolveThreadRouteTarget({
        threadId: ThreadId.makeUnsafe("missing-thread"),
        threads: [],
        draftThreadsByThreadId: {},
      }),
    ).toEqual({ kind: "missing" });
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { Thread } from "../types";
import { getLatestThreadForProject, sortThreads } from "./threadSort";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("sortThreads", () => {
  it("sorts threads by the latest user message in recency mode", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: ThreadId.make("thread-1"),
          updatedAt: "2026-03-09T10:10:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "user",
              text: "older",
              createdAt: "2026-03-09T10:01:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:01:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.make("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [
            {
              id: "message-2" as never,
              role: "user",
              text: "newer",
              createdAt: "2026-03-09T10:06:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:06:00.000Z",
            },
          ],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-2"),
      ThreadId.make("thread-1"),
    ]);
  });

  it("falls back to thread timestamps when there is no user message", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: ThreadId.make("thread-1"),
          updatedAt: "2026-03-09T10:01:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "assistant",
              text: "assistant only",
              createdAt: "2026-03-09T10:02:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:02:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.make("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-2"),
      ThreadId.make("thread-1"),
    ]);
  });

  it("falls back to createdAt when updatedAt is invalid", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: ThreadId.make("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "invalid-date" as never,
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-2"),
          createdAt: "2026-03-09T09:00:00.000Z",
          updatedAt: "2026-03-09T09:30:00.000Z",
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
    ]);
  });

  it("falls back to id ordering when threads have no sortable timestamps", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: ThreadId.make("thread-1"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-2"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-2"),
      ThreadId.make("thread-1"),
    ]);
  });

  it("can sort threads by createdAt when configured", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: ThreadId.make("thread-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-2"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
        }),
      ],
      "created_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
    ]);
  });

  it("uses updatedAt as a fallback for created_at sorting when createdAt is invalid", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: ThreadId.make("thread-1"),
          createdAt: "invalid-date" as never,
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-2"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
        }),
      ],
      "created_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
    ]);
  });

  it("returns the latest active thread for a project", () => {
    const latestThread = getLatestThreadForProject(
      [
        makeThread({
          id: ThreadId.make("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:01:00.000Z",
          archivedAt: null,
        }),
        makeThread({
          id: ThreadId.make("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
          archivedAt: "2026-03-10T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-3"),
          createdAt: "2026-03-09T10:06:00.000Z",
          updatedAt: "2026-03-09T10:06:00.000Z",
          archivedAt: null,
        }),
      ],
      PROJECT_ID,
      "updated_at",
    );

    expect(latestThread?.id).toBe(ThreadId.make("thread-3"));
  });
});

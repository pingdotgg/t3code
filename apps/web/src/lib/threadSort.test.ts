import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { Thread } from "../types";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import { sortThreads } from "./threadSort";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(overrides: ThreadFixtureOverrides = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
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
              runId: null,
              createdAt: "2026-03-09T10:01:00.000Z",
              updatedAt: "2026-03-09T10:01:00.000Z",
              streaming: false,
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
              runId: null,
              createdAt: "2026-03-09T10:06:00.000Z",
              updatedAt: "2026-03-09T10:06:00.000Z",
              streaming: false,
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
});

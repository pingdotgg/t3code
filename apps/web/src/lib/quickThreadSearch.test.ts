import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  QUICK_THREAD_SEARCH_RECENT_LIMIT,
  buildQuickThreadSearchIndex,
  buildQuickThreadSearchResults,
  createQuickThreadSearchSnippet,
} from "./quickThreadSearch";
import type { ChatMessage, Project, Thread } from "../types";

const ENVIRONMENT_ID = "environment-local" as EnvironmentId;
const PROJECT_ID = "project-1" as ProjectId;
const SECOND_PROJECT_ID = "project-2" as ProjectId;

function createUserMessage(id: string, text: string, createdAt: string): ChatMessage {
  return {
    id: id as MessageId,
    role: "user",
    text,
    createdAt,
    streaming: false,
  };
}

function createThread(input: {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  projectId?: ProjectId;
  archivedAt?: string | null;
  messages?: ChatMessage[];
}): Thread {
  return {
    id: input.id as ThreadId,
    environmentId: ENVIRONMENT_ID,
    codexThreadId: null,
    projectId: input.projectId ?? PROJECT_ID,
    title: input.title,
    modelSelection: {
      instanceId: "codex" as any,
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: input.messages ?? [],
    proposedPlans: [],
    error: null,
    createdAt: input.createdAt,
    archivedAt: input.archivedAt ?? null,
    updatedAt: input.updatedAt ?? input.createdAt,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
  };
}

describe("buildQuickThreadSearchIndex", () => {
  it("indexes the most recent unarchived threads only", () => {
    const threads = Array.from({ length: QUICK_THREAD_SEARCH_RECENT_LIMIT + 5 }, (_, index) =>
      createThread({
        id: `thread-${index}`,
        title: `Thread ${index}`,
        createdAt: new Date(Date.UTC(2026, 3, 1, 0, index, 0)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 3, 1, 1, index, 0)).toISOString(),
        archivedAt: index === 0 ? "2026-04-01T02:00:00.000Z" : null,
        messages: [
          createUserMessage(
            `message-${index}`,
            `Question ${index}`,
            new Date(Date.UTC(2026, 3, 1, 0, index, 30)).toISOString(),
          ),
        ],
      }),
    );

    const index = buildQuickThreadSearchIndex({
      threads,
      projects: [
        {
          id: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          name: "Project",
          cwd: "/repo",
          defaultModelSelection: null,
          scripts: [],
        },
      ],
    });

    expect(index).toHaveLength(QUICK_THREAD_SEARCH_RECENT_LIMIT);
    expect(index.some((entry) => entry.threadRef.threadId === ("thread-0" as ThreadId))).toBe(
      false,
    );
    expect(index[0]?.threadRef.threadId).toBe("thread-104");
  });
});

describe("buildQuickThreadSearchResults", () => {
  const projects: Project[] = [
    {
      id: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      name: "Primary project",
      cwd: "/repo/primary",
      defaultModelSelection: null,
      scripts: [],
    },
  ];

  it("prefers title matches over prompt-only matches", () => {
    const index = buildQuickThreadSearchIndex({
      threads: [
        createThread({
          id: "thread-title",
          title: "Debug flaky build",
          createdAt: "2026-04-16T12:00:00.000Z",
          updatedAt: "2026-04-16T12:05:00.000Z",
          messages: [
            createUserMessage(
              "message-a",
              "Need help shipping this PR",
              "2026-04-16T12:01:00.000Z",
            ),
          ],
        }),
        createThread({
          id: "thread-prompt",
          title: "Release checklist",
          createdAt: "2026-04-16T12:00:00.000Z",
          updatedAt: "2026-04-16T12:06:00.000Z",
          messages: [
            createUserMessage(
              "message-b",
              "Please debug why the queue stalled",
              "2026-04-16T12:02:00.000Z",
            ),
          ],
        }),
      ],
      projects,
    });

    const results = buildQuickThreadSearchResults({
      index,
      query: "debug",
    });

    expect(results.results).toHaveLength(2);
    expect(results.results[0]?.threadRef).toEqual(
      scopeThreadRef(ENVIRONMENT_ID, "thread-title" as ThreadId),
    );
    expect(results.results[0]?.matchedField).toBe("title");
    expect(results.results[1]?.matchedField).toBe("prompt");
  });

  it("falls back to an unknown project label and returns no results for blank queries", () => {
    const index = buildQuickThreadSearchIndex({
      threads: [
        createThread({
          id: "thread-unknown-project",
          title: "Investigate auth drift",
          createdAt: "2026-04-16T12:00:00.000Z",
          messages: [
            createUserMessage("message-c", "Auth drift on reconnect", "2026-04-16T12:01:00.000Z"),
          ],
          projectId: SECOND_PROJECT_ID,
        }),
      ],
      projects,
    });

    expect(
      buildQuickThreadSearchResults({
        index,
        query: "   ",
      }),
    ).toEqual({
      results: [],
      totalResults: 0,
      truncated: false,
    });

    const [result] = buildQuickThreadSearchResults({
      index,
      query: "auth",
    }).results;

    expect(result?.projectName).toBe("Unknown project");
  });
});

describe("createQuickThreadSearchSnippet", () => {
  it("adds ellipses when trimming long prompt matches", () => {
    expect(
      createQuickThreadSearchSnippet(
        "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda",
        23,
        30,
        8,
      ),
    ).toBe("…gamma delta epsilon zeta et…");
  });
});

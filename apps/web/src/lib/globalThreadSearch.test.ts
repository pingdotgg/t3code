import { EnvironmentId, type MessageId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildGlobalThreadSearchIndex, buildGlobalThreadSearchResults } from "./globalThreadSearch";
import type { Project, Thread } from "../types";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = "project-1" as ProjectId;

function createThread(input: {
  id: string;
  title: string;
  updatedAt: string;
  messages?: Thread["messages"];
  proposedPlans?: Thread["proposedPlans"];
}): Thread {
  return {
    id: input.id as ThreadId,
    environmentId: ENVIRONMENT_ID,
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: input.title,
    modelSelection: { instanceId: "codex" as any, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: input.messages ?? [],
    proposedPlans: input.proposedPlans ?? [],
    error: null,
    createdAt: "2026-04-17T12:00:00.000Z",
    archivedAt: null,
    updatedAt: input.updatedAt,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
  };
}

const PROJECTS: Project[] = [
  {
    id: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    name: "Project",
    cwd: "/repo/project",
    defaultModelSelection: null,
    scripts: [],
  },
];

describe("buildGlobalThreadSearchResults", () => {
  it("ranks title matches ahead of plan matches and keeps project labels", () => {
    const index = buildGlobalThreadSearchIndex({
      projects: PROJECTS,
      threads: [
        createThread({
          id: "thread-title",
          title: "Queue recovery plan",
          updatedAt: "2026-04-17T12:05:00.000Z",
          messages: [
            {
              id: "message-title" as MessageId,
              role: "user",
              text: "Ship it",
              createdAt: "2026-04-17T12:01:00.000Z",
              streaming: false,
            },
          ],
        }),
        createThread({
          id: "thread-plan",
          title: "Incident notes",
          updatedAt: "2026-04-17T12:06:00.000Z",
          proposedPlans: [
            {
              id: "plan-1" as Thread["proposedPlans"][number]["id"],
              turnId: null,
              planMarkdown: "Investigate the queue recovery path overnight.",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "2026-04-17T12:02:00.000Z",
              updatedAt: "2026-04-17T12:02:00.000Z",
            },
          ],
        }),
      ],
    });

    const results = buildGlobalThreadSearchResults({ index, query: "queue" });

    expect(results.results).toHaveLength(2);
    expect(results.results[0]?.threadTitle).toBe("Queue recovery plan");
    expect(results.results[0]?.matchedField).toBe("title");
    expect(results.results[0]?.projectName).toBe("Project");
    expect(results.results[1]?.matchedField).toBe("plan");
  });

  it("returns an empty result set for blank queries", () => {
    const index = buildGlobalThreadSearchIndex({
      projects: PROJECTS,
      threads: [
        createThread({ id: "thread-1", title: "Anything", updatedAt: "2026-04-17T12:00:00.000Z" }),
      ],
    });

    expect(buildGlobalThreadSearchResults({ index, query: "   " })).toEqual({
      results: [],
      totalResults: 0,
      truncated: false,
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-03-07T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 1,
  updatedAt: NOW,
  projects: [
    {
      id: ProjectId.makeUnsafe("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModel: "gpt-5-codex",
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.makeUnsafe("thread-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      title: "Thread",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      contextWindow: null,
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
};

describe("decideOrchestrationCommand", () => {
  it("emits thread.context-window-set for internal context updates", async () => {
    const event = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.context-window.set",
          commandId: CommandId.makeUnsafe("cmd-context-window"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          contextWindow: {
            provider: "codex",
            usedTokens: 119000,
            maxTokens: 258000,
            remainingTokens: 139000,
            usedPercent: 46,
            updatedAt: NOW,
          },
          createdAt: NOW,
        },
        readModel,
      }),
    );

    expect(Array.isArray(event)).toBe(false);
    expect(event).toMatchObject({
      type: "thread.context-window-set",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      payload: {
        threadId: "thread-1",
        contextWindow: {
          provider: "codex",
          usedPercent: 46,
        },
      },
    });
  });
});

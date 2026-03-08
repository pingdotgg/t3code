import { describe, expect, it } from "vitest";

import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationProject,
  type OrchestrationThread,
} from "@t3tools/contracts";

import { buildThreadHandoffText } from "./handoff";

const project: OrchestrationProject = {
  id: ProjectId.makeUnsafe("project-1"),
  title: "T3 Code",
  workspaceRoot: "/repo/t3code",
  defaultModel: "gpt-5.3-codex",
  scripts: [],
  createdAt: "2026-03-08T10:00:00.000Z",
  updatedAt: "2026-03-08T10:00:00.000Z",
  deletedAt: null,
};

const thread: OrchestrationThread = {
  id: ThreadId.makeUnsafe("thread-1"),
  projectId: ProjectId.makeUnsafe("project-1"),
  title: "Fix handoff flow",
  model: "gpt-5.3-codex",
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature/handoff",
  worktreePath: "/repo/t3code-worktree",
  latestTurn: {
    turnId: TurnId.makeUnsafe("turn-2"),
    state: "completed",
    requestedAt: "2026-03-08T10:05:00.000Z",
    startedAt: "2026-03-08T10:05:01.000Z",
    completedAt: "2026-03-08T10:05:20.000Z",
    assistantMessageId: MessageId.makeUnsafe("msg-2"),
  },
  createdAt: "2026-03-08T10:00:00.000Z",
  updatedAt: "2026-03-08T10:05:20.000Z",
  deletedAt: null,
  messages: [
    {
      id: MessageId.makeUnsafe("msg-1"),
      role: "user",
      text: "Build a handoff button that creates a compact new chat.",
      turnId: TurnId.makeUnsafe("turn-1"),
      streaming: false,
      createdAt: "2026-03-08T10:01:00.000Z",
      updatedAt: "2026-03-08T10:01:00.000Z",
      attachments: [],
    },
    {
      id: MessageId.makeUnsafe("msg-2"),
      role: "assistant",
      text: "I traced the existing thread creation flow and started wiring the handoff RPC.",
      turnId: TurnId.makeUnsafe("turn-2"),
      streaming: false,
      createdAt: "2026-03-08T10:05:20.000Z",
      updatedAt: "2026-03-08T10:05:20.000Z",
      attachments: [],
    },
  ],
  proposedPlans: [
    {
      id: "plan-1",
      turnId: TurnId.makeUnsafe("turn-2"),
      planMarkdown: "## Handoff\n\n- add RPC\n- create draft thread\n- block send until ready",
      createdAt: "2026-03-08T10:05:10.000Z",
      updatedAt: "2026-03-08T10:05:10.000Z",
    },
  ],
  activities: [
    {
      id: EventId.makeUnsafe("evt-1"),
      tone: "tool",
      kind: "tool.summary",
      summary: "Read the existing chat creation and provider routing code paths.",
      payload: {},
      turnId: TurnId.makeUnsafe("turn-2"),
      createdAt: "2026-03-08T10:05:05.000Z",
    },
  ],
  checkpoints: [],
  session: {
    threadId: ThreadId.makeUnsafe("thread-1"),
    status: "ready",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-03-08T10:05:20.000Z",
  },
};

describe("buildThreadHandoffText", () => {
  it("includes workspace, latest plan, and recent conversation context", () => {
    const handoff = buildThreadHandoffText({ project, thread });

    expect(handoff).toContain("## Workspace");
    expect(handoff).toContain("Active path: /repo/t3code-worktree");
    expect(handoff).toContain("## Latest proposed plan");
    expect(handoff).toContain("Build a handoff button");
    expect(handoff).toContain("## Continue from here");
  });
});

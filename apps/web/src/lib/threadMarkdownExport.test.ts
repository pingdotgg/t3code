import { describe, expect, it } from "vitest";
import {
  CheckpointRef,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@forma/contracts";

import { DraftId } from "~/composerDraftStore";
import { buildThreadMarkdownExport } from "./threadMarkdownExport";
import type { Thread } from "~/types";

const serverThread: Thread = {
  id: ThreadId.make("thread-1"),
  environmentId: EnvironmentId.make("environment-local"),
  codexThreadId: "codex-thread-1",
  projectId: ProjectId.make("project-1"),
  title: "Investigate workspace header",
  modelSelection: {
    provider: "codex",
    model: "gpt-5.4",
    options: [{ id: "reasoningEffort", value: "medium" }],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  session: {
    provider: "codex",
    status: "running",
    activeTurnId: TurnId.make("turn-1"),
    createdAt: "2026-05-01T10:00:00.000Z",
    updatedAt: "2026-05-01T10:05:00.000Z",
    orchestrationStatus: "running",
  },
  messages: [
    {
      id: MessageId.make("msg-1"),
      role: "user",
      text: "Please investigate the header menu.",
      attachments: [
        {
          type: "image",
          id: "attachment-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 42,
          previewUrl: "blob:preview-1",
        },
      ],
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-05-01T10:00:01.000Z",
      streaming: false,
    },
  ],
  proposedPlans: [
    {
      id: "plan-1",
      turnId: TurnId.make("turn-1"),
      planMarkdown: "# Header Plan\n\n- Move actions into a menu",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-05-01T10:01:00.000Z",
      updatedAt: "2026-05-01T10:02:00.000Z",
    },
  ],
  error: null,
  createdAt: "2026-05-01T09:59:00.000Z",
  archivedAt: null,
  updatedAt: "2026-05-01T10:06:00.000Z",
  latestTurn: {
    turnId: TurnId.make("turn-1"),
    state: "running",
    requestedAt: "2026-05-01T10:00:01.000Z",
    startedAt: "2026-05-01T10:00:02.000Z",
    completedAt: null,
    assistantMessageId: null,
  },
  branch: "feature/header-menu",
  worktreePath: "/repo/worktrees/header-menu",
  turnDiffSummaries: [
    {
      turnId: TurnId.make("turn-1"),
      completedAt: "2026-05-01T10:03:00.000Z",
      status: "ready",
      files: [{ path: "apps/web/src/components/chat/ChatHeader.tsx", additions: 12, deletions: 4 }],
      checkpointRef: CheckpointRef.make("checkpoint-1"),
      checkpointTurnCount: 1,
    },
  ],
  activities: [
    {
      id: EventId.make("activity-1"),
      summary: "Ran rg header menu",
      createdAt: "2026-05-01T10:00:03.000Z",
      turnId: TurnId.make("turn-1"),
      tone: "tool",
      kind: "command",
      payload: {
        text: "rg header menu",
      },
    },
  ],
  turnQueue: {
    items: [],
    status: "idle",
    pauseReason: null,
  },
};

describe("buildThreadMarkdownExport", () => {
  it("renders a full diagnostic export for server threads", () => {
    const markdown = buildThreadMarkdownExport({
      routeKind: "server",
      thread: serverThread,
      environmentId: serverThread.environmentId,
      project: {
        id: ProjectId.make("project-1"),
        name: "Harness",
        cwd: "/repo/project",
      },
      workspaceRoot: "/repo/worktrees/header-menu",
    });

    expect(markdown).toContain("# Investigate workspace header");
    expect(markdown).toContain("## Metadata");
    expect(markdown).toContain("- Route kind: server");
    expect(markdown).toContain("- Thread ID: thread-1");
    expect(markdown).toContain("- Project name: Harness");
    expect(markdown).toContain("- Latest turn summary: turn=turn-1; state=running;");
    expect(markdown).toContain("## Messages");
    expect(markdown).toContain("```md\nPlease investigate the header menu.\n```");
    expect(markdown).toContain("Preview URL: blob:preview-1");
    expect(markdown).toContain("## Proposed Plans");
    expect(markdown).toContain("### Plan 1: Header Plan");
    expect(markdown).toContain("```md\n# Header Plan\n\n- Move actions into a menu\n```");
    expect(markdown).toContain("## Checkpoints");
    expect(markdown).toContain('"checkpointRef": "checkpoint-1"');
    expect(markdown).toContain("## Activities");
    expect(markdown).toContain('"text": "rg header menu"');
    expect(markdown).toContain("## Turn Queue");
    expect(markdown).toContain('"status": "idle"');
  });

  it("renders predictable empty sections for draft threads", () => {
    const markdown = buildThreadMarkdownExport({
      routeKind: "draft",
      thread: {
        ...serverThread,
        title: "New thread",
        messages: [],
        proposedPlans: [],
        activities: [],
        turnDiffSummaries: [],
        latestTurn: null,
        session: null,
      },
      draftId: DraftId.make("draft-1"),
      project: {
        id: ProjectId.make("project-1"),
        name: "Harness",
        cwd: "/repo/project",
      },
      workspaceRoot: "/repo/project",
    });

    expect(markdown).toContain("- Route kind: draft");
    expect(markdown).toContain("- Draft ID: draft-1");
    expect(markdown).toContain("## Messages\n\nNone.");
    expect(markdown).toContain("## Proposed Plans\n\nNone.");
    expect(markdown).toContain("## Checkpoints\n\n```json\n[]\n```");
    expect(markdown).toContain("## Activities\n\n```json\n[]\n```");
  });
});

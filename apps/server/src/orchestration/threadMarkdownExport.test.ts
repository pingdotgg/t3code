import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationProjectShell,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  createThreadMarkdownExportFilename,
  formatThreadMarkdownExport,
} from "./threadMarkdownExport.ts";

describe("thread markdown export", () => {
  it("creates safe markdown filenames from chat titles", () => {
    expect(
      createThreadMarkdownExportFilename({
        title: "Fix: auth/session reconnect?",
        exportedAt: new Date("2026-06-01T07:49:33.574Z"),
      }),
    ).toBe("fix-auth-session-reconnect-2026-06-01T07-49-33Z.md");
  });

  it("includes prompts, responses, attachments, and turn metadata", () => {
    const projectId = ProjectId.make("project-1");
    const threadId = ThreadId.make("thread-1");
    const turnId = TurnId.make("turn-1");
    const project: OrchestrationProjectShell = {
      id: projectId,
      title: "T3 Code",
      workspaceRoot: "/tmp/t3code",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-06-01T07:00:00.000Z",
      updatedAt: "2026-06-01T07:00:00.000Z",
    };
    const thread: OrchestrationThread = {
      id: threadId,
      projectId,
      title: "Export chat",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      pendingRuntimeMode: null,
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-06-01T07:01:00.000Z",
        startedAt: "2026-06-01T07:01:01.000Z",
        completedAt: "2026-06-01T07:01:05.000Z",
        assistantMessageId: MessageId.make("message-assistant-1"),
      },
      createdAt: "2026-06-01T07:00:00.000Z",
      updatedAt: "2026-06-01T07:01:05.000Z",
      archivedAt: null,
      deletedAt: null,
      messages: [
        {
          id: MessageId.make("message-user-1"),
          role: "user",
          text: "Please implement export.",
          attachments: [
            {
              type: "image",
              id: "attachment-1",
              name: "mock.png",
              mimeType: "image/png",
              sizeBytes: 123,
            },
          ],
          turnId,
          streaming: false,
          createdAt: "2026-06-01T07:01:00.000Z",
          updatedAt: "2026-06-01T07:01:00.000Z",
        },
        {
          id: MessageId.make("message-assistant-1"),
          role: "assistant",
          text: "Export is implemented.",
          turnId,
          streaming: false,
          createdAt: "2026-06-01T07:01:02.000Z",
          updatedAt: "2026-06-01T07:01:05.000Z",
        },
      ],
      proposedPlans: [
        {
          id: "plan-1",
          turnId,
          planMarkdown: "- Add settings\n- Add RPC",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-06-01T07:00:30.000Z",
          updatedAt: "2026-06-01T07:00:30.000Z",
        },
      ],
      queuedTurns: [],
      activities: [
        {
          id: EventId.make("event-1"),
          tone: "tool",
          kind: "tool-call",
          summary: "Ran formatter",
          payload: { command: "bun fmt" },
          turnId,
          createdAt: "2026-06-01T07:01:03.000Z",
        },
      ],
      checkpoints: [
        {
          turnId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("checkpoint-1"),
          status: "ready",
          files: [{ path: "src/export.ts", kind: "modified", additions: 10, deletions: 2 }],
          agentTouchedPaths: ["src/export.ts"],
          turnFiles: [{ path: "src/export.ts", kind: "modified", additions: 10, deletions: 2 }],
          assistantMessageId: MessageId.make("message-assistant-1"),
          completedAt: "2026-06-01T07:01:05.000Z",
        },
      ],
      session: {
        threadId,
        status: "ready",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-06-01T07:01:05.000Z",
      },
    };

    const markdown = formatThreadMarkdownExport({
      thread,
      project,
      exportedAt: new Date("2026-06-01T07:49:33.574Z"),
    });

    expect(markdown).toContain("# Export chat");
    expect(markdown).toContain("| Project path | /tmp/t3code |");
    expect(markdown).toContain("Please implement export.");
    expect(markdown).toContain("Export is implemented.");
    expect(markdown).toContain("| attachment-1 | mock.png | image/png | 123 |");
    expect(markdown).toContain("| src/export.ts | modified | 10 | 2 |");
    expect(markdown).toContain("- Add settings\n- Add RPC");
    expect(markdown).toContain("Ran formatter");

    const conciseMarkdown = formatThreadMarkdownExport({
      thread,
      project,
      exportedAt: new Date("2026-06-01T07:49:33.574Z"),
      detail: {
        includeMetadata: false,
        includeToolCalls: false,
        includeDiffs: false,
        includePlans: false,
        includeQueuedTurns: false,
      },
    });

    expect(conciseMarkdown).toContain("Please implement export.");
    expect(conciseMarkdown).toContain("Export is implemented.");
    expect(conciseMarkdown).not.toContain("## Thread metadata");
    expect(conciseMarkdown).not.toContain("## Activity");
    expect(conciseMarkdown).not.toContain("| src/export.ts | modified | 10 | 2 |");
    expect(conciseMarkdown).not.toContain("- Add settings\n- Add RPC");
    expect(conciseMarkdown).not.toContain("Ran formatter");
  });

  it("renders a workspace handoff as one transition instead of a fake user turn", () => {
    const threadId = ThreadId.make("thread-handoff");
    const thread: OrchestrationThread = {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "Handoff chat",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      pendingRuntimeMode: null,
      interactionMode: "default",
      branch: "feature/handoff",
      worktreePath: "/tmp/handoff",
      latestTurn: null,
      createdAt: "2026-06-01T07:00:00.000Z",
      updatedAt: "2026-06-01T07:01:05.000Z",
      archivedAt: null,
      deletedAt: null,
      messages: [
        {
          id: MessageId.make("message-user-1"),
          role: "user",
          text: "Move this to a new worktree.",
          attachments: [],
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-06-01T07:01:00.000Z",
          updatedAt: "2026-06-01T07:01:00.000Z",
        },
        {
          id: MessageId.make("message-marker"),
          role: "system",
          text: "Moved to feature/handoff (/tmp/handoff)",
          origin: {
            kind: "workspace-handoff",
            role: "marker",
            branch: "feature/handoff",
            worktreePath: "/tmp/handoff",
          },
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-06-01T07:01:02.000Z",
          updatedAt: "2026-06-01T07:01:02.000Z",
        },
        {
          id: MessageId.make("message-continuation"),
          role: "user",
          text: "Continue the task from the previous user request in the newly bound workspace.",
          origin: {
            kind: "workspace-handoff",
            role: "continuation",
            branch: "feature/handoff",
            worktreePath: "/tmp/handoff",
          },
          attachments: [],
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: "2026-06-01T07:01:03.000Z",
          updatedAt: "2026-06-01T07:01:03.000Z",
        },
        {
          id: MessageId.make("message-assistant-2"),
          role: "assistant",
          text: "Done in the new worktree.",
          attachments: [],
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: "2026-06-01T07:01:04.000Z",
          updatedAt: "2026-06-01T07:01:04.000Z",
        },
      ],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    };

    const markdown = formatThreadMarkdownExport({
      thread,
      project: null,
      exportedAt: new Date("2026-06-01T07:49:33.574Z"),
    });

    expect(markdown).toContain("### Workspace moved");
    expect(markdown).toContain("| Branch | feature/handoff |");
    expect(markdown).not.toContain("Continue the task from the previous user request");
    // The work that happened after the move is still exported, and the move
    // itself does not consume a turn number.
    expect(markdown).toContain("Done in the new worktree.");
    expect(markdown).toContain("### Turn 1: turn-1");
    expect(markdown).toContain("### Turn 2: turn-2");
  });
});

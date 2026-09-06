import { describe, expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";

import type { QueuedThreadMessage } from "./thread-outbox-model";
import type { ComposerDraft } from "./use-composer-drafts";
import { buildPendingNewTasks, parseNewTaskDraftKey } from "./pending-new-tasks-model";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const NOW = "2026-09-05T12:00:00.000Z";

function queuedCreation(id: string, createdAt: string): QueuedThreadMessage {
  return {
    environmentId,
    threadId: ThreadId.make(`thread-${id}`),
    messageId: MessageId.make(id),
    commandId: CommandId.make(`command-${id}`),
    text: `queued ${id}`,
    attachments: [],
    createdAt,
    creation: {
      projectId,
      workspaceMode: "local",
      branch: "main",
      worktreePath: null,
    },
  };
}

function draft(text: string, overrides: Partial<ComposerDraft> = {}): ComposerDraft {
  return { text, attachments: [], ...overrides };
}

describe("parseNewTaskDraftKey", () => {
  it("splits the environment and project ids", () => {
    expect(parseNewTaskDraftKey(`new-task:${environmentId}:${projectId}`)).toEqual({
      environmentId,
      projectId,
    });
  });

  it("ignores thread drafts and pending-task editor drafts", () => {
    expect(parseNewTaskDraftKey(`${environmentId}:thread-1`)).toBeNull();
    expect(parseNewTaskDraftKey("pending-task:message-1")).toBeNull();
    expect(parseNewTaskDraftKey("new-task:")).toBeNull();
    expect(parseNewTaskDraftKey("new-task:env-only")).toBeNull();
  });
});

describe("buildPendingNewTasks", () => {
  it("surfaces new-task drafts with content alongside queued creations", () => {
    const tasks = buildPendingNewTasks({
      queuedMessages: [queuedCreation("a", "2026-09-05T10:00:00.000Z")],
      drafts: {
        [`new-task:${environmentId}:${projectId}`]: draft("fix the offline outbox", {
          workspaceSelection: { mode: "worktree", branch: "main", worktreePath: null },
        }),
      },
      now: NOW,
    });

    expect(tasks.map((task) => [task.kind, task.title, task.branch])).toEqual([
      ["draft", "fix the offline outbox", "main"],
      ["pending", "queued a", "main"],
    ]);
    expect(tasks[0]).toMatchObject({
      key: `draft-task:new-task:${environmentId}:${projectId}`,
      environmentId,
      projectId,
      draftKey: `new-task:${environmentId}:${projectId}`,
    });
  });

  it("hides settings-only drafts and drafts for other surfaces", () => {
    const tasks = buildPendingNewTasks({
      queuedMessages: [],
      drafts: {
        [`new-task:${environmentId}:${projectId}`]: draft("", {
          modelSelection: { instanceId: "codex" as never, model: "gpt" },
        }),
        [`new-task:${environmentId}:${projectId}-2`]: draft("   "),
        [`${environmentId}:thread-1`]: draft("thread composer text"),
        "pending-task:message-1": draft("editor copy of a queued task"),
      },
      now: NOW,
    });

    expect(tasks).toEqual([]);
  });

  it("titles an attachment-only draft by its attachment count", () => {
    const attachment = {
      type: "image",
      id: "image-1",
      uri: "file:///image-1.png",
      mimeType: "image/png",
      name: "image-1.png",
      width: 1,
      height: 1,
      sizeBytes: 1,
    } as unknown as ComposerDraft["attachments"][number];
    const tasks = buildPendingNewTasks({
      queuedMessages: [],
      drafts: {
        [`new-task:${environmentId}:${projectId}`]: draft("", { attachments: [attachment] }),
      },
      now: NOW,
    });

    expect(tasks.map((task) => task.title)).toEqual(["1 attachment"]);
  });

  it("orders queued creations newest first and skips existing-thread messages", () => {
    const tasks = buildPendingNewTasks({
      queuedMessages: [
        queuedCreation("old", "2026-09-05T08:00:00.000Z"),
        { ...queuedCreation("follow-up", "2026-09-05T11:00:00.000Z"), creation: undefined },
        queuedCreation("new", "2026-09-05T10:00:00.000Z"),
      ],
      drafts: {},
      now: NOW,
    });

    expect(tasks.map((task) => task.title)).toEqual(["queued new", "queued old"]);
  });
});

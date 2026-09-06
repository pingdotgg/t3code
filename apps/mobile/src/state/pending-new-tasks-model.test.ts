import { describe, expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";

import type { QueuedThreadMessage } from "./thread-outbox-model";
import type { ComposerDraft } from "./use-composer-drafts";
import { buildPendingNewTasks } from "./pending-new-tasks-model";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");

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

function draft(
  text: string,
  createdAt: string,
  overrides: Partial<ComposerDraft> = {},
): ComposerDraft {
  return {
    text,
    attachments: [],
    project: { environmentId, projectId, createdAt },
    ...overrides,
  };
}

describe("buildPendingNewTasks", () => {
  it("surfaces every new-task draft with content alongside queued creations", () => {
    const tasks = buildPendingNewTasks({
      queuedMessages: [queuedCreation("a", "2026-09-05T10:00:00.000Z")],
      drafts: {
        "new-task:draft-old": draft("first idea", "2026-09-05T09:00:00.000Z", {
          workspaceSelection: { mode: "worktree", branch: "main", worktreePath: null },
        }),
        "new-task:draft-new": draft("second idea", "2026-09-05T11:00:00.000Z"),
      },
    });

    expect(tasks.map((task) => [task.kind, task.title, task.branch])).toEqual([
      ["draft", "second idea", null],
      ["draft", "first idea", "main"],
      ["pending", "queued a", "main"],
    ]);
    expect(tasks[1]).toMatchObject({
      key: "draft-task:new-task:draft-old",
      environmentId,
      projectId,
      draftKey: "new-task:draft-old",
      createdAt: "2026-09-05T09:00:00.000Z",
    });
  });

  it("hides settings-only drafts, unstamped drafts, and drafts for other surfaces", () => {
    const tasks = buildPendingNewTasks({
      queuedMessages: [],
      drafts: {
        "new-task:settings-only": draft("", "2026-09-05T09:00:00.000Z", {
          modelSelection: { instanceId: "codex" as never, model: "gpt" },
        }),
        "new-task:blank": draft("   ", "2026-09-05T09:00:00.000Z"),
        "new-task:unstamped": { text: "no project", attachments: [] },
        [`${environmentId}:thread-1`]: { text: "thread composer text", attachments: [] },
        "pending-task:message-1": { text: "editor copy of a queued task", attachments: [] },
      },
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
        "new-task:with-image": draft("", "2026-09-05T09:00:00.000Z", {
          attachments: [attachment],
        }),
      },
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
    });

    expect(tasks.map((task) => task.title)).toEqual(["queued new", "queued old"]);
  });
});

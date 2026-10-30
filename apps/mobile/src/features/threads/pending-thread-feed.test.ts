import { describe, expect, it } from "vite-plus/test";
import type { QueuedThreadRun } from "@t3tools/client-runtime/state/thread-workflows";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import {
  appendPendingThreadMessages,
  isCompactionCommandFeedEntry,
  selectPendingAcknowledgedMessages,
} from "./pending-thread-feed";

const pending = (id: string): QueuedThreadMessage => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make(id),
  commandId: CommandId.make(id),
  text: id,
  attachments: [],
  createdAt: "2026-09-06T10:00:00.000Z",
});

const serverQueued = (id: string, overrides?: Partial<QueuedThreadRun>): QueuedThreadRun => ({
  run: {
    id: RunId.make(`run-${id}`),
    status: "queued",
    requestedAt: DateTime.makeUnsafe("2026-09-06T10:05:00.000Z"),
  } as QueuedThreadRun["run"],
  text: id,
  attachments: [],
  messageId: MessageId.make(id),
  ...overrides,
});

const feedIds = (entries: ReadonlyArray<{ readonly id: string }>) =>
  entries.map((entry) => entry.id);

describe("pending timeline messages", () => {
  it.each([false, true])(
    "keeps a queued compact command in the pending message row (attachment: %s)",
    (withAttachment) => {
      const queued = {
        ...pending("compact"),
        text: "/compact",
        attachments: withAttachment
          ? [
              {
                id: "image-1",
                type: "image" as const,
                name: "photo.png",
                mimeType: "image/png",
                sizeBytes: 3,
                fileUri: "file:///documents/photo.png",
                previewUri: "file:///documents/photo.png",
              },
            ]
          : [],
      };
      const entry = appendPendingThreadMessages([], [], [queued])[0]!;
      expect(isCompactionCommandFeedEntry(entry)).toBe(false);
      expect(entry.pendingMessage).toEqual(queued);
      if (!withAttachment) {
        expect(isCompactionCommandFeedEntry({ ...entry, pendingMessage: undefined })).toBe(true);
      }
    },
  );

  it("marks the synthetic creation prompt pending without duplicating it", () => {
    const queued = {
      ...pending("creation"),
      creation: {
        projectId: ProjectId.make("project"),
        workspaceMode: "local" as const,
        branch: "main",
        worktreePath: null,
      },
    };
    const prompt = appendPendingThreadMessages([], [], [queued])[0]!;
    const synthetic = { ...prompt, pendingMessage: undefined };
    const result = appendPendingThreadMessages([synthetic], [synthetic], [queued]);
    expect(result).toHaveLength(1);
    expect(result[0]?.pendingMessage).toEqual(queued);
    expect(result[0]?.acknowledged).toBe(false);
  });

  it("retains context records while a message is waiting for delivery", () => {
    const record = {
      version: 1 as const,
      kind: "mention" as const,
      contextId: ComposerContextId.make("setup-file"),
      label: "Checkout.tsx",
      path: "src/Checkout.tsx",
    };
    const context = { version: 1 as const, records: [record] };
    const text = "[Checkout.tsx](t3-context://v1/mention/setup-file)";
    const entries = appendPendingThreadMessages([], [], [{ ...pending("context"), text, context }]);
    const entry = entries[0];
    expect(entry?.type).toBe("message");
    if (entry?.type !== "message") throw new Error("Expected a pending message");
    expect(entry.message.text).toBe(text);
    expect(entry.message.context).toEqual(context);
  });

  it("keeps pending messages after newer agent activity in queue order", () => {
    const activity = {
      type: "thinking",
      runId: null,
      id: "thinking",
      createdAt: "2026-09-06T11:00:00.000Z",
    } as const;
    const entries = appendPendingThreadMessages(
      [activity],
      [],
      [pending("first"), pending("second")],
    );
    expect(entries.map((entry) => entry.id)).toEqual(["thinking", "first", "second"]);
    expect(entries[1]?.pendingMessage?.text).toBe("first");
  });

  it("reuses the message id and suppresses the pending copy when delivery appears", () => {
    const queued = pending("sent");
    const optimistic = appendPendingThreadMessages([], [], [queued])[0]!;
    const delivered = { ...optimistic, pendingMessage: undefined };
    expect(appendPendingThreadMessages([delivered], [delivered], [queued])).toEqual([delivered]);
    expect(appendPendingThreadMessages([], [delivered], [queued])).toEqual([]);
  });

  it("keeps an accepted follow-up in the feed while the server queues it", () => {
    const local = pending("follow-up");
    const outbox = appendPendingThreadMessages([], [], [local], []);
    expect(outbox[0]?.pendingMessage).toEqual(local);
    expect(outbox[0]?.queued).toBeUndefined();

    const queued = appendPendingThreadMessages([], [], [], [serverQueued("follow-up")]);
    expect(feedIds(queued)).toEqual(["follow-up"]);
    expect(queued[0]?.queued).toBe(true);
    expect(queued[0]?.pendingMessage).toBeUndefined();
    expect(queued[0]?.createdAt).toBe("2026-09-06T10:05:00.000Z");
    if (queued[0]?.type !== "message") throw new Error("Expected a queued message");
    expect(queued[0].message).toMatchObject({ role: "user", text: "follow-up", runId: null });

    const started = { ...queued[0], queued: undefined };
    expect(appendPendingThreadMessages([started], [started], [], [])).toEqual([started]);
  });

  it("prefers the outbox copy while both hold the message", () => {
    const local = pending("both");
    const entries = appendPendingThreadMessages([], [], [local], [serverQueued("both")]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.pendingMessage).toEqual(local);
    expect(entries[0]?.queued).toBeUndefined();
    const mixed = appendPendingThreadMessages(
      [],
      [],
      [local, pending("unsent")],
      [serverQueued("both"), serverQueued("later")],
    );
    expect(feedIds(mixed)).toEqual(["both", "later", "unsent"]);
    expect(mixed[0]?.pendingMessage).toEqual(local);
    expect(mixed[0]?.queued).toBeUndefined();
    expect(mixed[1]?.queued).toBe(true);
  });

  it("does not repeat a queued message the feed already shows, even collapsed", () => {
    const shown = appendPendingThreadMessages([], [], [], [serverQueued("shown")])[0]!;
    const delivered = { ...shown, queued: undefined };
    expect(
      appendPendingThreadMessages([delivered], [delivered], [], [serverQueued("shown")]),
    ).toEqual([delivered]);
    expect(appendPendingThreadMessages([], [delivered], [], [serverQueued("shown")])).toEqual([]);
  });

  it("follows server queue order and drops cancelled runs", () => {
    const activity = {
      type: "thinking",
      runId: null,
      id: "thinking",
      createdAt: "2026-09-06T11:00:00.000Z",
    } as const;
    const first = serverQueued("first");
    const second = serverQueued("second");
    const third = serverQueued("third");
    expect(
      feedIds(appendPendingThreadMessages([activity], [], [], [first, second, third])),
    ).toEqual(["thinking", "first", "second", "third"]);
    expect(
      feedIds(appendPendingThreadMessages([activity], [], [], [third, first, second])),
    ).toEqual(["thinking", "third", "first", "second"]);
    expect(feedIds(appendPendingThreadMessages([activity], [], [], [third, second]))).toEqual([
      "thinking",
      "third",
      "second",
    ]);
    expect(
      feedIds(appendPendingThreadMessages([activity], [], [pending("unsent")], [first])),
    ).toEqual(["thinking", "first", "unsent"]);
  });

  it("keeps a queued message's attachments, context and attribution", () => {
    const context = {
      version: 1 as const,
      records: [
        {
          version: 1 as const,
          kind: "mention" as const,
          contextId: ComposerContextId.make("file"),
          label: "Checkout.tsx",
          path: "src/Checkout.tsx",
        },
      ],
    };
    const attachment = {
      type: "image" as const,
      id: "attachment-1",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    const entry = appendPendingThreadMessages(
      [],
      [],
      [],
      [
        serverQueued("rich", {
          attachments: [attachment],
          context,
          message: {
            createdBy: "agent",
            creationSource: "server",
            scheduledTaskId: ScheduledTaskId.make("sample-schedule"),
            senderThreadId: ThreadId.make("sender-thread"),
          } as NonNullable<QueuedThreadRun["message"]>,
        }),
      ],
    )[0];
    if (entry?.type !== "message") throw new Error("Expected a queued message");
    expect(entry.message.attachments).toEqual([attachment]);
    expect(entry.message.context).toEqual(context);
    expect(entry.message).toMatchObject({
      createdBy: "agent",
      creationSource: "server",
      scheduledTaskId: "sample-schedule",
      senderThreadId: "sender-thread",
    });
  });

  it("shows a queued compact command as its text until the run starts", () => {
    const entry = appendPendingThreadMessages(
      [],
      [],
      [],
      [serverQueued("compact", { text: "/compact" })],
    )[0]!;
    expect(isCompactionCommandFeedEntry(entry)).toBe(false);
    expect(isCompactionCommandFeedEntry({ ...entry, queued: undefined })).toBe(true);
  });

  it("stops showing an acknowledged message once the projection holds it, even when the feed hides it", () => {
    // A rolled-back or cancelled queued run keeps its message in projection.messages
    // while its user_message item leaves the visible feed.
    const echoed = pending("rolled-back");
    // A bounded projection pages an applied message out; it must not come back as pending.
    const pagedOut = { ...pending("paged-out"), sequence: 40 };
    const waiting = { ...pending("waiting"), sequence: 50 };
    const shown = selectPendingAcknowledgedMessages([echoed, pagedOut, waiting], {
      threadKey: "env:thread",
      queuedMessages: [],
      sequence: 45,
      projectedMessages: [{ id: echoed.messageId }],
    });
    expect(shown).toEqual([waiting]);
    expect(appendPendingThreadMessages([], [], shown).map((entry) => entry.id)).toEqual([
      "waiting",
    ]);
  });
});

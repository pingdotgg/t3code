import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import {
  appendAcceptedThreadMessages,
  appendPendingThreadMessages,
  createPendingTurnAppender,
  createThreadFeedGrouping,
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

describe("pending timeline messages", () => {
  it("keeps unchanged row identities while text streams and updates adjacent grouping", () => {
    const group = createThreadFeedGrouping();
    const [first, second, third] = appendPendingThreadMessages(
      [],
      [],
      [pending("first"), pending("second"), pending("third")],
    );
    if (first?.type !== "message" || second?.type !== "message" || third?.type !== "message") {
      throw new Error("Expected message rows");
    }
    const reply = {
      ...third,
      id: "reply",
      message: { ...third.message, role: "assistant" as const, text: "start" },
    };
    const initial = group([first, second, reply], {});
    const streamed = group(
      [first, second, { ...reply, message: { ...reply.message, text: "streamed" } }],
      {},
    );
    expect(streamed[0]).toBe(initial[0]);
    expect(streamed[1]).toBe(initial[1]);
    expect(streamed[2]).not.toBe(initial[2]);
    const appended = group([first, second, third, reply], {});
    expect(appended[0]).toBe(initial[0]);
    expect(appended[1]).not.toBe(initial[1]);
    expect(appended[1]?.userMessageGrouping.groupedWithNext).toBe(true);
    expect(appended[2]?.userMessageGrouping.groupedWithPrevious).toBe(true);
    const removed = group([first, second, reply], {});
    expect(removed[1]?.userMessageGrouping.groupedWithNext).toBe(false);
    const steer = {
      ...second,
      message: { ...second.message, inputIntent: "promoted_queued_to_steer" as const },
    };
    const singleSteer = group([first, steer], {});
    const steers = group(
      [{ ...first, message: { ...first.message, inputIntent: "steer" } }, steer],
      {},
    );
    expect(steers[1]?.userMessageGrouping.continuesSteer).toBe(true);
    expect(singleSteer[1]?.userMessageGrouping.continuesSteer).toBe(false);
    expect(steers[1]).not.toBe(singleSteer[1]);
  });

  it("preserves setup, workflow, and compaction grouping boundaries", () => {
    const group = createThreadFeedGrouping();
    const feed = appendPendingThreadMessages([], [], [pending("first"), pending("second")]);
    expect(group(feed, {})[0]?.userMessageGrouping.groupedWithNext).toBe(true);
    for (const options of [{ setupAnchorIndex: 0 }, { workflowOpeningMessageId: "first" }]) {
      const rows = group(feed, options);
      expect(rows[0]?.userMessageGrouping.groupedWithNext).toBe(false);
      expect(rows[1]?.userMessageGrouping.groupedWithPrevious).toBe(false);
    }
    const compact = appendPendingThreadMessages(
      [],
      [],
      [{ ...pending("compact"), text: "/compact" }],
    )[0]!;
    expect(group([feed[0]!, compact], {})[0]?.userMessageGrouping.groupedWithNext).toBe(true);
    expect(
      group([feed[0]!, { ...compact, pendingMessage: undefined }], {})[0]?.userMessageGrouping
        .groupedWithNext,
    ).toBe(false);
  });

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

  it("keeps a new thread's first message attachments after delivery until the server copy loads", () => {
    const video = {
      id: "video-1",
      type: "file" as const,
      name: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 3,
      fileUri: "file:///documents/clip.mp4",
    };
    const creation = {
      ...pending("creation"),
      attachments: [video],
      creation: {
        projectId: ProjectId.make("project"),
        workspaceMode: "worktree" as const,
        branch: "main",
        worktreePath: null,
      },
    };
    const synthetic = {
      ...appendPendingThreadMessages([], [], [creation])[0]!,
      pendingMessage: undefined,
    };
    // Delivered and caught up by sequence, but the server's copy is not projected yet.
    const result = appendAcceptedThreadMessages([synthetic], [], creation);
    expect(result).toHaveLength(1);
    expect(result[0]?.pendingMessage?.attachments).toEqual([video]);
    expect(result[0]?.acknowledged).toBe(true);
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

  it("stops showing an acknowledged message once the thread catches up, even when the feed hides it", () => {
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

  it("holds the run's rows after a sent message until the run shows", () => {
    const appendTurn = createPendingTurnAppender();
    const sent = appendPendingThreadMessages([], [], [pending("sent")]);
    const held = appendTurn(sent, { zen: false });
    expect(held.map((entry) => [entry.id, "label" in entry ? entry.label : null])).toEqual([
      ["sent", null],
      ["pending-fold:sent", null],
      ["live-activity-row", "Sending…"],
    ]);
    expect(appendTurn(sent, { zen: false })[1]).toBe(held[1]);
    const delivered = sent.map((entry) => ({ ...entry, acknowledged: true }));
    expect(appendTurn(delivered, { zen: true }).map((entry) => entry.id)).toEqual([
      "sent",
      "live-activity-row",
    ]);
    // A working run already shows its own rows.
    const thinking = {
      type: "thinking",
      runId: null,
      id: "thinking",
      createdAt: "2026-09-06T11:00:00.000Z",
    } as const;
    const working = appendPendingThreadMessages([thinking], [], [pending("queued")]);
    expect(appendTurn(working, { zen: false })).toBe(working);
  });
});

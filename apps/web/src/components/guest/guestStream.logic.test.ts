import {
  GuestMessageId,
  GuestShareId,
  type GuestShareView,
  type GuestStreamEvent,
  type ThreadGuestMessage,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGuestStreamEvent,
  formatGuestExpiry,
  groupGuestTranscript,
  initialGuestStreamState,
  inviteShareId,
  parseGuestStreamEvent,
  unplacedGuestMessages,
  type GuestStreamState,
} from "./guestStream.logic";

const view: GuestShareView = {
  shareId: GuestShareId.make("share-1"),
  title: "Fix login",
  guestName: "Sam",
  expiresAt: "2026-10-24T00:00:00.000Z",
  working: true,
  messages: [],
};

const apply = (events: ReadonlyArray<GuestStreamEvent>, state = initialGuestStreamState) =>
  events.reduce<GuestStreamState>(applyGuestStreamEvent, state);

describe("applyGuestStreamEvent", () => {
  it("replaces everything on snapshot, so a reconnect drops stale items", () => {
    const before = apply([
      { type: "snapshot", view, items: [{ kind: "tool", id: "old", tool: "file_search" }] },
      { type: "ended" },
    ]);
    const after = apply(
      [
        {
          type: "snapshot",
          view,
          items: [{ kind: "user", id: "u1", text: "hi", streaming: false }],
        },
      ],
      before,
    );
    expect(after).toEqual({
      view,
      items: [{ kind: "user", id: "u1", text: "hi", streaming: false }],
      ended: false,
      awaitingRowIds: new Set(),
    });
  });

  it("ends when the shared cookie starts opening another link", () => {
    const state = apply([
      { type: "snapshot", view, items: [] },
      { type: "snapshot", view: { ...view, shareId: GuestShareId.make("share-2") }, items: [] },
    ]);
    expect(state.ended).toBe(true);
    expect(state.view?.shareId).toBe(view.shareId);
  });

  it("remembers a waiting message across a reconnect until its row arrives", () => {
    const waiting = {
      id: GuestMessageId.make("m1"),
      text: "Why?",
      status: "pending" as const,
      submittedAt: "2026-10-23T10:00:00.000Z",
    };
    const sent = { ...waiting, status: "sent" as const };
    const queued = apply([
      { type: "snapshot", view: { ...view, messages: [waiting] }, items: [] },
      { type: "snapshot", view: { ...view, messages: [sent] }, items: [] },
    ]);
    expect([...queued.awaitingRowIds]).toEqual([waiting.id]);

    // Once placed, a later snapshot whose window no longer holds the row must not resurrect it.
    const row = { kind: "user" as const, id: "u1", text: "Why?", streaming: false };
    const placed = apply(
      [
        { type: "item", item: { ...row, guestMessageId: waiting.id } },
        { type: "snapshot", view: { ...view, messages: [sent] }, items: [] },
      ],
      queued,
    );
    expect(placed.awaitingRowIds.size).toBe(0);
  });

  it("upserts items by id and keeps their order", () => {
    const state = apply([
      { type: "snapshot", view, items: [] },
      { type: "item", item: { kind: "assistant", id: "a1", text: "Hel", streaming: true } },
      { type: "item", item: { kind: "tool", id: "t1", tool: "command" } },
      { type: "item", item: { kind: "assistant", id: "a1", text: "Hello", streaming: false } },
    ]);
    expect(state.items.map((item) => item.id)).toEqual(["a1", "t1"]);
    expect(state.items[0]).toEqual({
      kind: "assistant",
      id: "a1",
      text: "Hello",
      streaming: false,
    });
  });

  it("appends streamed text to the matching item and ignores unknown ids", () => {
    const state = apply([
      {
        type: "snapshot",
        view,
        items: [{ kind: "assistant", id: "a1", text: "Hel", streaming: true }],
      },
      { type: "append", id: "a1", text: "lo", streaming: true },
      { type: "append", id: "missing", text: "x", streaming: false },
      { type: "append", id: "a1", text: "!", streaming: false },
    ]);
    expect(state.items).toEqual([
      { kind: "assistant", id: "a1", text: "Hello!", streaming: false },
    ]);
  });

  it("marks the stream ended", () => {
    expect(apply([{ type: "snapshot", view, items: [] }, { type: "ended" }]).ended).toBe(true);
  });
});

describe("parseGuestStreamEvent", () => {
  it("decodes a valid frame and rejects malformed ones", () => {
    expect(parseGuestStreamEvent(JSON.stringify({ type: "ended" }))).toEqual({ type: "ended" });
    expect(parseGuestStreamEvent("{not json")).toBeNull();
    expect(parseGuestStreamEvent(JSON.stringify({ type: "unknown" }))).toBeNull();
  });
});

describe("unplacedGuestMessages", () => {
  const message = (id: string, status: ThreadGuestMessage["status"], submittedAt: string) => ({
    id: GuestMessageId.make(id),
    text: id,
    status,
    submittedAt,
  });
  const placedItem = (id: string) => ({
    kind: "user" as const,
    id: `u-${id}`,
    text: id,
    streaming: false,
    guestMessageId: GuestMessageId.make(id),
  });

  it("shows pending ones, and resolved ones only if this page saw them waiting", () => {
    const messages = [
      message("late", "pending", "2026-10-23T10:05:00.000Z"),
      message("placed", "sent", "2026-10-23T10:00:00.000Z"),
      message("queued", "sent", "2026-10-23T09:59:00.000Z"),
      message("dismissed", "dismissed", "2026-10-23T10:01:00.000Z"),
      message("old-history", "sent", "2026-10-23T09:00:00.000Z"),
    ];
    const seen = new Set(
      ["placed", "queued", "dismissed", "late"].map((id) => GuestMessageId.make(id)),
    );
    expect(unplacedGuestMessages(messages, [placedItem("placed")], seen).map((m) => m.id)).toEqual([
      "queued",
      "dismissed",
      "late",
    ]);
  });
});

describe("formatGuestExpiry", () => {
  const now = Date.parse("2026-10-23T00:00:00.000Z");
  it("shows whole hours, then minutes, then expired", () => {
    expect(formatGuestExpiry("2026-10-23T23:59:00.000Z", now)).toBe("23h left");
    expect(formatGuestExpiry("2026-10-23T00:45:30.000Z", now)).toBe("45m left");
    expect(formatGuestExpiry("2026-10-23T00:00:00.000Z", now)).toBe("Expired");
  });
});

describe("inviteShareId", () => {
  it("reads the share id before the signature and rejects anything else", () => {
    expect(inviteShareId("k3J9xQ2mT8vL5nR1pW7yZa.sig")).toBe("k3J9xQ2mT8vL5nR1pW7yZa");
    expect(inviteShareId("no-signature")).toBeNull();
    expect(inviteShareId(".sig")).toBeNull();
    expect(inviteShareId("")).toBeNull();
  });
});

describe("groupGuestTranscript", () => {
  it("folds each stretch of tool calls into one line between messages", () => {
    const tool = (id: string, kind: "command" | "file_search") =>
      ({ kind: "tool", id, tool: kind }) as const;
    const text = { kind: "assistant", id: "a1", text: "Done", streaming: false } as const;
    const rows = groupGuestTranscript([
      tool("t1", "command"),
      tool("t2", "file_search"),
      tool("t3", "command"),
      text,
      tool("t4", "command"),
    ]);
    expect(rows).toEqual([
      { kind: "work", id: "t1", line: "Ran 2 commands, searched files" },
      { kind: "item", item: text },
      { kind: "work", id: "t4", line: "Ran a command" },
    ]);
  });
});

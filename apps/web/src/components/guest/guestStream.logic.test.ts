import {
  EventId,
  GuestMessageId,
  GuestShareId,
  MessageId,
  ProviderDriverKind,
  RunId,
  TurnItemId,
  type GuestShareView,
  type GuestStreamEvent,
  type OrchestrationV2TurnItem,
  type ThreadGuestMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadProjectionFixture } from "../../test-fixtures";
import {
  applyGuestStreamEvent,
  formatGuestExpiry,
  guestFilesProblem,
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
  messages: [],
  model: { driver: null, name: "gpt-5.4" },
};

const projection = makeThreadProjectionFixture();
const now = DateTime.makeUnsafe("2026-10-23T10:00:00.000Z");

const base = {
  threadId: projection.thread.id,
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
} as const;

const reply = (id: string, text: string): OrchestrationV2TurnItem => ({
  ...base,
  id: TurnItemId.make(id),
  type: "assistant_message",
  messageId: MessageId.make(id),
  text,
  streaming: false,
});

const guestMessageRow = (id: string, guestMessageId: GuestMessageId): OrchestrationV2TurnItem => ({
  ...base,
  id: TurnItemId.make(id),
  type: "user_message",
  createdBy: "user",
  creationSource: "web",
  messageId: MessageId.make(id),
  inputIntent: "turn_start",
  text: "Why?",
  context: { version: 1, records: [], guest: { guestMessageId, name: "Sam", text: "Why?" } },
  attachments: [],
});

const snapshot = (snapshotSequence = 1): GuestStreamEvent => ({
  type: "thread",
  item: { kind: "snapshot", snapshotSequence, projection },
});

const itemEvent = (sequence: number, item: OrchestrationV2TurnItem): GuestStreamEvent => ({
  type: "thread",
  item: {
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-${sequence}`),
      type: "turn-item.updated",
      threadId: projection.thread.id,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: projection.thread.providerInstanceId,
      occurredAt: now,
      payload: item,
    },
  },
});

const apply = (
  events: ReadonlyArray<Parameters<typeof applyGuestStreamEvent>[1]>,
  state = initialGuestStreamState,
) => events.reduce<GuestStreamState>(applyGuestStreamEvent, state);

const itemIds = (state: GuestStreamState) =>
  state.projection?.visibleTurnItems.map((row) => row.item.id) ?? [];

describe("applyGuestStreamEvent", () => {
  it("builds the thread from the snapshot and applies each later event once", () => {
    const once = apply([{ type: "view", view }, snapshot(1), itemEvent(2, reply("a1", "Hi"))]);
    expect(itemIds(once)).toEqual(["a1"]);
    // A replayed or older event changes nothing.
    expect(apply([itemEvent(2, reply("a1", "Changed"))], once)).toBe(once);
  });

  it("merges older pages in front, only for the cursor the thread is at", () => {
    const windowed: GuestStreamEvent = {
      type: "thread",
      item: {
        kind: "snapshot",
        snapshotSequence: 1,
        projection,
        historyCursor: "cursor-1",
        hasMoreHistory: true,
      },
    };
    const page = (id: string, nextCursor: string | null) => ({
      snapshotSequence: 1,
      items: [
        {
          position: 0,
          visibility: "local" as const,
          sourceThreadId: projection.thread.id,
          sourceItemId: TurnItemId.make(id),
          item: reply(id, "Earlier"),
        },
      ],
      nextCursor,
      hasMoreHistory: nextCursor !== null,
    });
    const live = apply([windowed, itemEvent(2, reply("a1", "Hi"))]);
    expect(live.historyCursor).toBe("cursor-1");
    // A page fetched before a reconnect moved the cursor changes nothing.
    const stale = { type: "history-page" as const, cursor: "cursor-0", page: page("old", null) };
    expect(applyGuestStreamEvent(live, stale)).toBe(live);
    const merged = applyGuestStreamEvent(live, {
      type: "history-page",
      cursor: "cursor-1",
      page: page("o1", null),
    });
    expect(itemIds(merged)).toEqual(["o1", "a1"]);
    expect(merged.historyCursor).toBeNull();
  });

  it("replaces the thread on a new snapshot, as after a reconnect", () => {
    const before = apply([snapshot(1), itemEvent(2, reply("a1", "Hi")), { type: "ended" }]);
    const after = apply([snapshot(1)], { ...before, ended: false });
    expect(itemIds(after)).toEqual([]);
  });

  it("ends when the view names another link than the page's", () => {
    const state = apply([
      { type: "view", view },
      { type: "view", view: { ...view, shareId: GuestShareId.make("share-2") } },
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
      { type: "view", view: { ...view, messages: [waiting] } },
      snapshot(1),
      { type: "view", view: { ...view, messages: [sent] } },
    ]);
    expect([...queued.awaitingRowIds]).toEqual([waiting.id]);

    // Once placed, a later snapshot whose window no longer holds the row must not resurrect it.
    const placed = apply([itemEvent(2, guestMessageRow("u1", waiting.id)), snapshot(3)], queued);
    expect(placed.awaitingRowIds.size).toBe(0);
  });

  it("forgets a dismissed message once the guest clears it", () => {
    const waiting = {
      id: GuestMessageId.make("m1"),
      text: "Why?",
      status: "pending" as const,
      submittedAt: "2026-10-23T10:00:00.000Z",
    };
    const dismissed = { ...waiting, status: "dismissed" as const };
    const shown = apply([
      { type: "view", view: { ...view, messages: [waiting] } },
      snapshot(1),
      { type: "view", view: { ...view, messages: [dismissed] } },
    ]);
    expect([...shown.awaitingRowIds]).toEqual([waiting.id]);

    const cleared = apply(
      [
        { type: "message-cleared", id: waiting.id },
        { type: "view", view: { ...view, messages: [dismissed] } },
      ],
      shown,
    );
    expect(cleared.awaitingRowIds.size).toBe(0);
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
    const items = [
      {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: projection.thread.id,
        sourceItemId: TurnItemId.make("u1"),
        item: guestMessageRow("u1", GuestMessageId.make("placed")),
      },
    ];
    expect(unplacedGuestMessages(messages, items, seen).map((m) => m.id)).toEqual([
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

describe("guestFilesProblem", () => {
  const file = (type: string, size = 1) => ({ type, size });
  it("takes up to four files and 10 MB, with images in the types the owner's composer takes", () => {
    expect(guestFilesProblem([file("image/png"), file("application/pdf"), file("")])).toBeNull();
    expect(guestFilesProblem([1, 2, 3, 4, 5].map(() => file("image/png")))).toMatch(/up to 4/);
    expect(guestFilesProblem([file("image/png", 10 * 1024 * 1024 + 1)])).toMatch(/10 MB/);
    expect(guestFilesProblem([file("image/svg+xml")])).toMatch(/PNG, JPEG, GIF, or WebP/);
    expect(guestFilesProblem([file("text/plain", 0)])).toMatch(/cannot be attached/);
  });
});

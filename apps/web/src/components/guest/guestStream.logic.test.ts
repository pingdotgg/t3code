import {
  GuestMessageId,
  GuestShareId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type GuestRun,
  type GuestShareView,
  type GuestStreamEvent,
  type GuestTurnItem,
  type ThreadGuestMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGuestStreamEvent,
  deriveGuestActivity,
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

const base = {
  threadId: ThreadId.make("thread"),
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
} as const;

const reply = (id: string, text: string, streaming = false): GuestTurnItem => ({
  ...base,
  id: TurnItemId.make(id),
  type: "assistant_message",
  messageId: MessageId.make(id),
  text,
  streaming,
});

const guestMessageRow = (id: string, guestMessageId: GuestMessageId): GuestTurnItem => ({
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

const run = (id: string, ordinal: number, status: GuestRun["status"]): GuestRun => ({
  id: RunId.make(id),
  ordinal,
  status,
  requestedAt: "2026-10-23T10:00:00.000Z",
  startedAt: status === "queued" ? null : "2026-10-23T10:00:01.000Z",
  completedAt: null,
  workStartedAt: "2026-10-23T10:00:02.000Z",
  turnEnded: false,
});

const snapshot = (
  items: ReadonlyArray<GuestTurnItem>,
  overrides: Partial<Extract<GuestStreamEvent, { type: "snapshot" }>> = {},
): GuestStreamEvent => ({ type: "snapshot", view, runs: [], items, ...overrides });

const apply = (events: ReadonlyArray<GuestStreamEvent>, state = initialGuestStreamState) =>
  events.reduce<GuestStreamState>(applyGuestStreamEvent, state);

describe("applyGuestStreamEvent", () => {
  it("replaces everything on snapshot, so a reconnect drops stale items and runs", () => {
    const before = apply([
      snapshot([reply("old", "stale")], { runs: [run("run-0", 1, "running")] }),
      { type: "ended" },
    ]);
    const after = apply([snapshot([reply("a1", "hi")])], before);
    expect(after.ended).toBe(false);
    expect(after.runs).toEqual([]);
    expect(after.items.map((row) => row.item.id)).toEqual(["a1"]);
  });

  it("feeds the timeline local rows of this thread", () => {
    const [row] = apply([snapshot([reply("a1", "hi")])]).items;
    expect(row).toMatchObject({
      visibility: "local",
      sourceThreadId: "thread",
      sourceItemId: "a1",
      item: { type: "assistant_message", text: "hi" },
    });
  });

  it("ends when the shared cookie starts opening another link", () => {
    const state = apply([
      snapshot([]),
      snapshot([], { view: { ...view, shareId: GuestShareId.make("share-2") } }),
    ]);
    expect(state.ended).toBe(true);
    expect(state.view?.shareId).toBe(view.shareId);
  });

  it("updates an item in place, adds new ones at the end, and keeps other rows as they were", () => {
    const start = apply([snapshot([reply("a1", "Hel", true), reply("a2", "Next")])]);
    const state = apply(
      [
        { type: "item", item: reply("a1", "Hello", false) },
        { type: "item", item: reply("a3", "Last") },
      ],
      start,
    );
    expect(state.items.map((row) => [row.item.id, row.position])).toEqual([
      ["a1", 0],
      ["a2", 1],
      ["a3", 2],
    ]);
    expect(state.items[0]?.item).toMatchObject({ text: "Hello", streaming: false });
    // Unchanged rows keep their identity, so the timeline skips re-rendering them.
    expect(state.items[1]).toBe(start.items[1]);
  });

  it("updates runs by id", () => {
    const state = apply([
      snapshot([], { runs: [run("run-1", 1, "completed")] }),
      { type: "run", run: run("run-2", 2, "running") },
      { type: "run", run: run("run-2", 2, "completed") },
    ]);
    expect(state.runs.map((guestRun) => [guestRun.id, guestRun.status])).toEqual([
      ["run-1", "completed"],
      ["run-2", "completed"],
    ]);
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
      snapshot([], { view: { ...view, messages: [waiting] } }),
      snapshot([], { view: { ...view, messages: [sent] } }),
    ]);
    expect([...queued.awaitingRowIds]).toEqual([waiting.id]);

    // Once placed, a later snapshot whose window no longer holds the row must not resurrect it.
    const placed = apply(
      [
        { type: "item", item: guestMessageRow("u1", waiting.id) },
        snapshot([], { view: { ...view, messages: [sent] } }),
      ],
      queued,
    );
    expect(placed.awaitingRowIds.size).toBe(0);
  });

  it("marks the stream ended", () => {
    expect(apply([snapshot([]), { type: "ended" }]).ended).toBe(true);
  });
});

describe("deriveGuestActivity", () => {
  it("follows the newest working run, with when its work started", () => {
    const activity = deriveGuestActivity([
      run("run-1", 1, "completed"),
      run("run-2", 2, "running"),
      run("run-3", 3, "queued"),
    ]);
    expect(activity.isWorking).toBe(true);
    expect(activity.run).toMatchObject({ runId: "run-2", status: "running" });
    expect(activity.workStartedAt).toBe("2026-10-23T10:00:02.000Z");
  });

  it("passes on that the reply ended while the run still captures its checkpoint", () => {
    const capturing = { ...run("run-1", 1, "waiting"), turnEnded: true };
    expect(deriveGuestActivity([capturing]).run).toMatchObject({ turnEnded: true });
  });

  it("shows the newest run that left the queue when nothing works", () => {
    const activity = deriveGuestActivity([
      run("run-1", 1, "completed"),
      run("run-2", 2, "interrupted"),
      run("run-3", 3, "queued"),
    ]);
    expect(activity).toMatchObject({
      isWorking: false,
      run: { runId: "run-2", status: "interrupted" },
      workStartedAt: null,
    });
    expect(deriveGuestActivity([]).run).toBeNull();
  });
});

describe("parseGuestStreamEvent", () => {
  it("decodes a valid frame and rejects malformed ones", () => {
    expect(parseGuestStreamEvent(JSON.stringify({ type: "ended" }))).toEqual({ type: "ended" });
    expect(parseGuestStreamEvent("{not json")).toBeNull();
    expect(parseGuestStreamEvent(JSON.stringify({ type: "unknown" }))).toBeNull();
  });

  it("decodes item dates for the timeline", () => {
    const event = parseGuestStreamEvent(
      JSON.stringify({
        type: "item",
        item: { ...reply("a1", "hi"), updatedAt: "2026-10-23T10:00:00.000Z" },
      }),
    );
    expect(event?.type === "item" && DateTime.formatIso(event.item.updatedAt)).toBe(
      "2026-10-23T10:00:00.000Z",
    );
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
    const { items } = apply([snapshot([guestMessageRow("u1", GuestMessageId.make("placed"))])]);
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

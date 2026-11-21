import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  type CardView,
  type EngineRequest,
  type RequestRow,
  type BoardOpenItems,
  type ForYouCard,
  NO_TOASTS,
  nextToasts,
  type SentCard,
  cardViews,
  engineRequestsOf,
  forYouMessage,
  mergeForYou,
  openCards,
} from "./forYou";

const item = (id: string, kind: string, status: string, createdAt: string, extra = {}) =>
  JSON.stringify({
    id,
    kind,
    title: `Title ${id}`,
    body: `Body ${id}`,
    status,
    createdAt,
    ...extra,
  });

const condition = (met: boolean, evidence: string[] = []) => ({ met, evidence });
const conditions = {
  ci_green: condition(true, ["pr/ci.log"]),
  reviews_fixed: condition(true, ["reviews/r1.md", "reviews/r2.md"]),
  delta_rereviewed: condition(true, ["reviews/delta.md"]),
  readmes_pass: condition(true, ["readme-check.txt"]),
  parent_ready: { met: false, note: "Merge after T-1" },
  smoke_named: condition(true, ["smoke/lane-1.png"]),
};

const request = (kind: EngineRequest["kind"], id: string, createdAt: string): EngineRequest => ({
  kind,
  id,
  threadId: `th-${id}`,
  threadTitle: `[T-1] ${id}`,
  createdAt,
});

const idsOf = (cards: ReadonlyArray<ForYouCard>) => cards.map((card) => card.id);

describe("for-you list", () => {
  const file = [
    item("mrg-1", "merge_approval", "open", "2026-11-20T10:05:00Z", { conditions }),
    item("q-1", "question", "open", "2026-11-20T10:00:00Z", { options: ["Ship it", "Wait"] }),
    item("g-1", "gate", "open", "2026-11-20T10:10:00Z"),
    item("r-1", "read", "held", "2026-11-20T09:00:00Z"),
    JSON.stringify({ id: "g-1", status: "resolved", resolution: "Approved" }),
  ].join("\n");

  it("Given a file and two engine requests, when they are merged, then open cards come first by age, then held, then resolved", () => {
    const merged = mergeForYou(file, [
      request("secret", "sec-1", "2026-11-20T10:07:00Z"),
      request("approval", "req-1", "2026-11-20T10:02:00Z"),
    ]);
    expect(idsOf(merged.cards)).toEqual(["q-1", "req-1", "mrg-1", "sec-1", "r-1", "g-1"]);
    expect(merged.problems).toEqual([]);
  });

  it("Given a later update line, when the file is merged, then the item keeps its fields and takes the new status and resolution", () => {
    const resolved = mergeForYou(file, []).cards.find((card) => card.id === "g-1");
    expect(resolved).toMatchObject({
      origin: "file",
      item: { id: "g-1", title: "Title g-1", status: "resolved", resolution: "Approved" },
    });
  });

  it("Given a merge approval, when it is merged, then it carries all six conditions with their evidence", () => {
    const card = mergeForYou(file, []).cards.find((entry) => entry.id === "mrg-1");
    expect(
      card?.origin === "file" && card.item.kind === "merge_approval" ? card.item.conditions : null,
    ).toEqual(conditions);
  });

  it("Given an id used twice, when the list is merged, then the latest file line wins and the engine request with that id is dropped", () => {
    const text = [
      item("a", "gate", "open", "2026-11-20T10:00:00Z"),
      item("a", "gate", "held", "2026-11-20T10:00:00Z", { title: "Newer" }),
    ].join("\n");
    const merged = mergeForYou(text, [
      request("approval", "a", "2026-11-20T10:01:00Z"),
      request("approval", "b", "2026-11-20T10:02:00Z"),
      request("approval", "b", "2026-11-20T10:03:00Z"),
    ]);
    expect(idsOf(merged.cards)).toEqual(["b", "a"]);
    expect(merged.cards[1]).toMatchObject({
      origin: "file",
      item: { status: "held", title: "Newer" },
    });
  });

  it("Given an invalid line, when the file is merged, then the line is skipped and reported with its number", () => {
    const text = [
      item("a", "gate", "open", "2026-11-20T10:00:00Z"),
      "",
      "not json",
      JSON.stringify({
        id: "b",
        kind: "merge_approval",
        title: "x",
        body: "",
        status: "open",
        createdAt: "t",
      }),
      JSON.stringify({ id: "c", status: "open" }),
      item("d", "read", "open", "2026-11-20T10:01:00Z"),
    ].join("\n");
    const merged = mergeForYou(text, []);
    expect(idsOf(merged.cards)).toEqual(["a", "d"]);
    expect(merged.problems.map((problem) => problem.line)).toEqual([3, 4, 5]);
    expect(merged.problems[1]?.message).toContain("conditions");
  });

  it("Given no file, when it is merged, then only the engine requests show", () => {
    const merged = mergeForYou(null, [request("secret", "s", "2026-11-20T10:00:00Z")]);
    expect(idsOf(merged.cards)).toEqual(["s"]);
    expect(openCards(merged.cards)).toHaveLength(1);
  });

  it("Given held and resolved items, when the open cards are counted, then only open ones count", () => {
    const merged = mergeForYou(file, [request("approval", "r", "2026-11-20T10:00:00Z")]);
    expect(idsOf(openCards(merged.cards))).toEqual(["q-1", "r", "mrg-1"]);
  });
});

describe("engine requests", () => {
  const row = (id: string, pending: { kind: string; userOnly?: boolean } | null): RequestRow => ({
    id,
    title: `Thread ${id}`,
    pendingRuntimeRequest:
      pending === null
        ? null
        : {
            id: `req-${id}`,
            createdAt: DateTime.makeUnsafe("2026-11-20T10:00:00.000Z"),
            ...pending,
          },
  });

  it("Given threads with approvals, user-only questions, and ordinary questions, when the requests are listed, then only approvals and secrets are", () => {
    const requests = engineRequestsOf([
      row("a", { kind: "command" }),
      row("b", { kind: "user_input", userOnly: true }),
      row("c", { kind: "user_input" }),
      row("d", { kind: "auth_refresh" }),
      row("e", null),
      row("f", { kind: "file_change" }),
    ]);
    expect(requests).toEqual([
      {
        kind: "approval",
        id: "req-a",
        threadId: "a",
        threadTitle: "Thread a",
        createdAt: "2026-11-20T10:00:00.000Z",
      },
      {
        kind: "secret",
        id: "req-b",
        threadId: "b",
        threadTitle: "Thread b",
        createdAt: "2026-11-20T10:00:00.000Z",
      },
      {
        kind: "approval",
        id: "req-f",
        threadId: "f",
        threadTitle: "Thread f",
        createdAt: "2026-11-20T10:00:00.000Z",
      },
    ]);
  });
});

describe("answering a card", () => {
  it("Given a choice, when the message is worded, then it names the item id and the choice", () => {
    expect(forYouMessage("mrg-1", { type: "choice", choice: "approve" })).toBe(
      "For you item mrg-1: approve",
    );
    expect(forYouMessage("q-1", { type: "text", text: "Ship it" })).toBe(
      "For you item q-1: answer: Ship it",
    );
  });

  it("Given an approval that made a tracker change, when the message is worded, then the outcome follows on its own line", () => {
    expect(
      forYouMessage("tw-1", {
        type: "choice",
        choice: "approve",
        result: 'Moved 7 to "Done"',
      }),
    ).toBe('For you item tw-1: approve\nResult: Moved 7 to "Done"');
  });

  it("Given a tracker_write item, when the file is merged, then it is a card with its exact change and a line without one is a problem", () => {
    const write = { action: "comment", tracker: "github", scope: "a/b", key: "7", body: "Done." };
    const merged = mergeForYou(
      [
        item("tw-1", "tracker_write", "open", "2026-11-21T10:00:00Z", { write }),
        item("tw-2", "tracker_write", "open", "2026-11-21T10:01:00Z"),
      ].join("\n"),
      [],
    );
    expect(merged.cards.map((card) => card.id)).toEqual(["tw-1"]);
    expect(merged.cards[0]).toMatchObject({ item: { kind: "tracker_write", write } });
    expect(merged.problems).toHaveLength(1);
    expect(merged.problems[0]?.line).toBe(2);
  });

  const open = mergeForYou(item("a", "gate", "open", "2026-11-20T10:00:00Z"), [
    request("approval", "req", "2026-11-20T10:01:00Z"),
  ]).cards;
  const sent = (card: ForYouCard, status: SentCard["status"], choice = "approve") =>
    new Map<string, SentCard>([[card.id, { card, choice, status }]]);
  const states = (views: ReadonlyArray<CardView>) => views.map((view) => view.state);

  it("Given an answered open item, when the file still says open, then the card is sent", () => {
    expect(states(cardViews(open, sent(open[0]!, "open")))).toEqual(["sent", "open"]);
  });

  it("Given an answered item, when the file moves it to held or resolved, then the card shows the file's status", () => {
    const held = mergeForYou(item("a", "gate", "held", "2026-11-20T10:00:00Z"), []).cards;
    expect(states(cardViews(held, sent(open[0]!, "open")))).toEqual(["held"]);
    const resolved = mergeForYou(
      [
        item("a", "gate", "open", "2026-11-20T10:00:00Z"),
        JSON.stringify({ id: "a", status: "resolved", resolution: "Approved" }),
      ].join("\n"),
      [],
    ).cards;
    expect(cardViews(resolved, sent(open[0]!, "open"))).toEqual([
      { card: resolved[0], state: "resolved", detail: "Approved" },
    ]);
  });

  it("Given an answered engine request, when the engine drops it, then a secret stays resolved and an approval leaves", () => {
    const secret: ForYouCard = {
      origin: "engine",
      id: "sec",
      request: request("secret", "sec", "2026-11-20T10:00:00Z"),
    };
    const approval: ForYouCard = {
      origin: "engine",
      id: "req",
      request: request("approval", "req", "2026-11-20T10:00:00Z"),
    };
    const records = new Map<string, SentCard>([
      ["sec", { card: secret, choice: "Saved securely", status: "open" }],
      ["req", { card: approval, choice: "Approved", status: "open" }],
    ]);
    expect(cardViews([], records)).toEqual([
      { card: secret, state: "resolved", detail: "Saved securely" },
    ]);
  });
});

describe("toasts", () => {
  const board = (boardId: string, loaded: boolean, ids: ReadonlyArray<string>): BoardOpenItems => ({
    projectId: `p-${boardId}`,
    folder: boardId,
    boardId,
    boardName: `Board ${boardId}`,
    loaded,
    open: ids.map((id) => ({ id, title: `Title ${id}` })),
  });
  const cardIds = (state: ReturnType<typeof nextToasts>) =>
    state.toasts.map((toast) => toast.cardId);

  it("Given items already waiting at the first read, when a board loads, then none toast", () => {
    expect(cardIds(nextToasts(NO_TOASTS, [board("a", true, ["x", "y"])]))).toEqual([]);
  });

  it("Given a board that has not loaded, when items appear, then it stays unrecorded until it loads", () => {
    const early = nextToasts(NO_TOASTS, [board("a", false, ["x"])]);
    expect(early.seen.has("a")).toBe(false);
    expect(cardIds(nextToasts(early, [board("a", true, ["x"])]))).toEqual([]);
  });

  it("Given a loaded board, when a new item appears on two boards, then each toasts once and names its board", () => {
    const first = nextToasts(NO_TOASTS, [board("a", true, []), board("b", true, ["old"])]);
    const next = nextToasts(first, [board("a", true, ["x"]), board("b", true, ["old", "y"])]);
    expect(next.toasts).toEqual([
      {
        id: "a/x",
        projectId: "p-a",
        folder: "a",
        boardId: "a",
        boardName: "Board a",
        cardId: "x",
        title: "Title x",
      },
      {
        id: "b/y",
        projectId: "p-b",
        folder: "b",
        boardId: "b",
        boardName: "Board b",
        cardId: "y",
        title: "Title y",
      },
    ]);
  });
});

import { assert, describe, it } from "@effect/vitest";
import {
  fyiDeliveryState,
  fyiElement,
  MessageId,
  NodeId,
  OrchestrationV2RunStatus,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import {
  decideWake,
  FYI_TOOL_BATCH_BUDGET_CHARS,
  FYI_TURN_BUDGET_CHARS,
  FYI_WAITING_SQL,
  type FyiItem,
  type FyiWakeDecision,
  type FyiWakeFacts,
  renderForToolBatch,
  renderForTurn,
  turnCarriesFyi,
  wakeRuns,
} from "./Fyi.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const threadId = ThreadId.make("thread:fyi");

const fyiItem = (index: number, text: string, sentAt: string): FyiItem => ({
  id: TurnItemId.make(`item:${index}`),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: index,
  status: "pending",
  title: null,
  startedAt: at(sentAt),
  completedAt: null,
  updatedAt: at(sentAt),
  type: "user_message",
  messageId: MessageId.make(`message:${index}`),
  createdBy: "agent",
  creationSource: "mcp",
  senderThreadId: ThreadId.make("thread:chief"),
  inputIntent: "steer",
  text,
  attachments: [],
  fyi: true,
});

describe("FYI_WAITING_SQL", () => {
  it.layer(SqlitePersistence.layerMemory)((it) => {
    it.effect("selects exactly the items fyiDeliveryState calls waiting", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const node = NodeId.make("node:carrier");
        const cases = [
          { runless: true, nodeId: null, run: null },
          { runless: false, nodeId: node, run: null },
          { runless: false, nodeId: null, run: { status: "completed", rootNodeId: null } },
          ...OrchestrationV2RunStatus.literals.flatMap((status) => [
            { runless: false, nodeId: node, run: { status, rootNodeId: node } },
            { runless: false, nodeId: node, run: { status, rootNodeId: NodeId.make("node:2") } },
          ]),
        ] as const;
        for (const [index, row] of cases.entries()) {
          const runId = row.runless ? null : `run:${index}`;
          // A bind writes "completed"; the rule reads the run, not the item's status.
          yield* sql`INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id, thread_id, run_id, node_id, ordinal, type, status, updated_at, payload_json)
            VALUES (${`item:${index}`}, ${threadId}, ${runId}, ${row.nodeId}, ${index}, 'user_message',
              ${row.runless ? "pending" : "completed"}, '2026-11-16T00:00:00.000Z', '{"fyi":true}')`;
          if (runId !== null && row.run !== null) {
            yield* sql`INSERT INTO orchestration_v2_projection_runs
              (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
              VALUES (${runId}, ${threadId}, ${index}, 'codex', ${row.run.status},
                '2026-11-16T00:00:00.000Z', ${JSON.stringify({ rootNodeId: row.run.rootNodeId })})`;
          }
        }
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
          VALUES ('item:plain', ${threadId}, NULL, 999, 'user_message', 'pending',
            '2026-11-16T00:00:00.000Z', '{}')`;
        const selected = new Set(
          (yield* sql<{ readonly turn_item_id: string }>`
            SELECT item.turn_item_id FROM orchestration_v2_projection_turn_items item
            LEFT JOIN orchestration_v2_projection_runs run ON run.run_id = item.run_id
            WHERE ${sql.literal(FYI_WAITING_SQL)}`).map((row) => row.turn_item_id),
        );
        for (const [index, row] of cases.entries()) {
          const expected =
            fyiDeliveryState(
              { runId: row.runless ? null : RunId.make(`run:${index}`), nodeId: row.nodeId },
              row.run ?? undefined,
            ) === "waiting";
          assert.strictEqual(selected.has(`item:${index}`), expected, JSON.stringify(row));
        }
        assert.isFalse(selected.has("item:plain"), "a message without fyi never waits");
      }),
    );
  });
});

describe("turnCarriesFyi", () => {
  it.each([
    ["a prose message", "Fix the flaky test", [], false, true],
    ["/compact", "/compact", [], false, false],
    ["a slash command after spaces", "  /review", [], false, false],
    ["a slash message with an image", "/look at this", [{}], false, true],
    ["a goal command", "/goal ship it", [], true, false],
    ["a skill mention", "$deploy ship it", [], false, false],
    ["a skill mention with another sigil after spaces", "  €review the plan", [], false, false],
    ["a skill mention with an image", "$review this", [{}], false, false],
    ["a price", "$25 is the budget", [], false, true],
    ["a skill mention later in the text", "Then run $deploy", [], false, true],
  ] as const)("%s", (_name, text, attachments, goalCommand, expected) => {
    assert.strictEqual(
      turnCarriesFyi({
        message: { text, attachments, createdBy: "user", creationSource: "web" },
        goalCommand,
        resumesNatively: false,
      }),
      expected,
    );
  });
});

describe("renderForTurn", () => {
  it("renders oldest first under one header", () => {
    const rendered = renderForTurn([
      fyiItem(2, "second", "2026-11-16T02:00:00.000Z"),
      fyiItem(1, "first", "2026-11-16T01:00:00.000Z"),
    ]);
    assert.strictEqual(
      rendered.text,
      [
        "FYI messages for you. No action is needed. Use one only if it changes your current work.",
        '<fyi from="thread thread:chief" sent="2026-11-16T01:00:00.000Z">\nfirst\n</fyi>',
        '<fyi from="thread thread:chief" sent="2026-11-16T02:00:00.000Z">\nsecond\n</fyi>',
      ].join("\n\n"),
    );
    assert.deepStrictEqual(
      rendered.rendered.map((item) => item.text),
      ["first", "second"],
    );
  });

  it("skips whole entries past the budget and counts them", () => {
    const half = "x".repeat(FYI_TURN_BUDGET_CHARS / 2);
    const rendered = renderForTurn([
      fyiItem(1, half, "2026-11-16T01:00:00.000Z"),
      fyiItem(2, half, "2026-11-16T02:00:00.000Z"),
      fyiItem(3, "small", "2026-11-16T03:00:00.000Z"),
      fyiItem(4, "small", "2026-11-16T04:00:00.000Z"),
    ]);
    assert.deepStrictEqual(
      rendered.rendered.map((item) => item.ordinal),
      [1, 3, 4],
    );
    assert.isTrue(rendered.text.endsWith("\n\n1 more FYI message waits for later."));
  });

  it("always renders the oldest entry, even past the budget", () => {
    const rendered = renderForTurn([
      fyiItem(1, "x".repeat(FYI_TURN_BUDGET_CHARS * 2), "2026-11-16T01:00:00.000Z"),
      fyiItem(2, "small", "2026-11-16T02:00:00.000Z"),
    ]);
    assert.deepStrictEqual(
      rendered.rendered.map((item) => item.ordinal),
      [1],
    );
    assert.isTrue(rendered.text.endsWith("\n\n1 more FYI message waits for later."));
  });

  it("renders nothing when nothing waits", () => {
    assert.deepStrictEqual(renderForTurn([]), { text: "", rendered: [] });
  });
});

describe("renderForToolBatch", () => {
  const overhead = fyiElement(fyiItem(0, "", "2026-11-16T01:00:00.000Z")).length;
  it.each([
    [
      "skips an entry that does not fit and takes the ones after it",
      [10, FYI_TOOL_BATCH_BUDGET_CHARS, 10],
      [1, 3],
    ],
    ["counts the header in the budget", [FYI_TOOL_BATCH_BUDGET_CHARS - overhead], []],
  ])("%s", (_name, sizes, expected) => {
    const rendered = renderForToolBatch(
      sizes.map((size, index) =>
        fyiItem(index + 1, "x".repeat(size), `2026-11-16T0${index + 1}:00:00.000Z`),
      ),
    );
    assert.deepStrictEqual(
      rendered.rendered.map((item) => item.ordinal),
      expected,
    );
    assert.isAtMost(rendered.text.length, FYI_TOOL_BATCH_BUDGET_CHARS);
  });
});

describe("decideWake", () => {
  const now = at("2026-11-16T12:00:00.000Z");
  const idle = {
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    createdAt: at("2026-11-16T00:00:00.000Z"),
    snoozedUntil: null,
  } as const;
  const run = (
    status: OrchestrationV2Run["status"],
    completedAt: string | null = "2026-11-16T01:00:00.000Z",
  ) => ({
    status,
    requestedAt: at("2026-11-16T00:00:00.000Z"),
    startedAt: at("2026-11-16T00:00:00.000Z"),
    completedAt: completedAt === null ? null : at(completedAt),
  });

  it.each<
    [
      string,
      Partial<Omit<FyiWakeFacts, "runs">> & {
        readonly runs?: Parameters<typeof wakeRuns>[0];
      },
      FyiWakeDecision,
    ]
  >([
    ["nothing waits", { fyiWaiting: false }, { due: false, reason: "nothing_waiting" }],
    ["archived", { thread: { ...idle, archivedAt: now } }, { due: false, reason: "archived" }],
    ["deleted", { thread: { ...idle, deletedAt: now } }, { due: false, reason: "deleted" }],
    [
      "settled",
      { thread: { ...idle, settledOverride: "settled" } },
      { due: false, reason: "settled" },
    ],
    ["a live run", { runs: [run("running", null)] }, { due: false, reason: "live_run" }],
    [
      "a turn draining output",
      { runs: [run("waiting", null)] },
      { due: false, reason: "live_run" },
    ],
    [
      "a held queued run",
      { runs: [run("completed"), run("queued", null)] },
      { due: false, reason: "queued_run" },
    ],
    [
      "a request that waits for an answer",
      { pendingRequest: true },
      { due: false, reason: "pending_request" },
    ],
    [
      "a disabled provider",
      { providerEnabled: false },
      { due: false, reason: "provider_disabled" },
    ],
    [
      "6 hours idle with an FYI waiting",
      {},
      { due: true, idleFrom: at("2026-11-16T01:00:00.000Z") },
    ],
    [
      "due once 6 hours have passed since the last run",
      { now: at("2026-11-16T07:00:00.000Z") },
      { due: true, idleFrom: at("2026-11-16T01:00:00.000Z") },
    ],
    [
      "under 6 hours since the latest run ended",
      { runs: [run("completed", "2026-11-16T09:00:00.000Z")] },
      { due: false, reason: "not_yet", dueAt: at("2026-11-16T15:00:00.000Z") },
    ],
    [
      "under 6 hours since an earlier run ended after a later one was cancelled",
      {
        runs: [
          run("completed", "2026-11-16T09:00:00.000Z"),
          {
            ...run("cancelled", "2026-11-16T03:00:00.000Z"),
            startedAt: null,
            requestedAt: at("2026-11-16T03:00:00.000Z"),
          },
        ],
      },
      { due: false, reason: "not_yet", dueAt: at("2026-11-16T15:00:00.000Z") },
    ],
    [
      "a run that never started counts from its request",
      {
        runs: [
          {
            ...run("cancelled", null),
            startedAt: null,
            requestedAt: at("2026-11-16T10:00:00.000Z"),
          },
        ],
      },
      { due: false, reason: "not_yet", dueAt: at("2026-11-16T16:00:00.000Z") },
    ],
    [
      "a thread with no run counts from its creation",
      { runs: [] },
      { due: true, idleFrom: at("2026-11-16T00:00:00.000Z") },
    ],
    [
      "a thread with no run created under 6 hours ago",
      { runs: [], thread: { ...idle, createdAt: at("2026-11-16T07:00:00.000Z") } },
      { due: false, reason: "not_yet", dueAt: at("2026-11-16T13:00:00.000Z") },
    ],
    [
      "snoozed past 6 hours idle",
      { thread: { ...idle, snoozedUntil: at("2026-11-16T13:00:00.000Z") } },
      { due: false, reason: "not_yet", dueAt: at("2026-11-16T13:00:00.000Z") },
    ],
    [
      "a snooze that ended does not move the idle hours",
      { thread: { ...idle, snoozedUntil: at("2026-11-16T11:00:00.000Z") } },
      { due: true, idleFrom: at("2026-11-16T01:00:00.000Z") },
    ],
    [
      "a usage limit counts idle hours from its reset",
      { limitResetAt: at("2026-11-16T09:00:00.000Z") },
      { due: false, reason: "not_yet", dueAt: at("2026-11-16T15:00:00.000Z") },
    ],
    [
      "6 hours idle since a usage limit reset",
      { limitResetAt: at("2026-11-16T05:00:00.000Z") },
      { due: true, idleFrom: at("2026-11-16T05:00:00.000Z") },
    ],
    [
      "a usage limit that resets later",
      { limitResetAt: at("2026-11-16T13:00:00.000Z") },
      { due: false, reason: "not_yet", dueAt: at("2026-11-16T19:00:00.000Z") },
    ],
    [
      "a usage limit counts idle hours from a snooze that ends after its reset",
      {
        limitResetAt: at("2026-11-16T03:00:00.000Z"),
        thread: { ...idle, snoozedUntil: at("2026-11-16T10:00:00.000Z") },
      },
      { due: false, reason: "not_yet", dueAt: at("2026-11-16T16:00:00.000Z") },
    ],
  ])("%s", (_name, { runs = [run("completed")], ...override }, expected) => {
    assert.deepStrictEqual(
      decideWake({
        thread: idle,
        fyiWaiting: true,
        limitResetAt: undefined,
        pendingRequest: false,
        providerEnabled: true,
        now,
        ...override,
        runs: wakeRuns(runs),
      }),
      expected,
    );
  });
});

import * as NodeOS from "node:os";

import { expect, it } from "@effect/vitest";
import {
  type AgentFeedbackMode,
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type Project,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Analytics from "../telemetry/AnalyticsService.ts";
import {
  FEEDBACK_AWAITING_APPROVAL_NOTE,
  FeedbackInput,
  FeedbackStorageError,
} from "./FeedbackReport.ts";
import { listFeedbackReports } from "./FeedbackList.ts";
import * as Feedback from "./FeedbackService.ts";
import { buildFeedbackTrace } from "./FeedbackTrace.ts";
import * as Store from "./FeedbackStore.ts";

const threadId = ThreadId.make("thread:feedback");
const instanceId = ProviderInstanceId.make("work-codex");

const at = (ms: number) => DateTime.makeUnsafe(ms);
const run = (ordinal: number, started = true) =>
  ({
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.5" },
    rootNodeId: `node:${ordinal}`,
    startedAt: started ? at(ordinal * 60_000) : null,
  }) as unknown as OrchestrationV2Run;
let ordinal = 0;
const item = (runOrdinal: number, fields: Record<string, unknown>) =>
  ({
    runId: RunId.make(`run:${runOrdinal}`),
    parentItemId: null,
    ordinal: ordinal++,
    status: "completed",
    startedAt: null,
    completedAt: null,
    ...fields,
  }) as unknown as OrchestrationV2TurnItem;
// Four queued runs after the six started ones: the trace still covers five started turns.
const runs = [1, 2, 3, 4, 5, 6]
  .map((ordinal) => run(ordinal))
  .concat([7, 8, 9, 10].map((ordinal) => run(ordinal, false)));
const turnItems = [
  item(1, { type: "user_message", text: "Outside the window." }),
  ...[2, 3, 4, 5].map((turn) => item(turn, { type: "user_message", text: `Ask ${turn}.` })),
  ...Array.from({ length: 100 }, () => item(3, { type: "command_execution", exitCode: 0 })),
  item(5, { type: "assistant_message", text: "Done in /srv/checkouts/acme-app-7." }),
  item(6, {
    type: "dynamic_tool",
    toolName: "mcp__t3-code__t3_thread_read",
    status: "failed",
    startedAt: at(0),
    completedAt: at(1_500),
  }),
  item(6, {
    type: "dynamic_tool",
    toolName: "mcp__linear__get_issue",
    toolSource: { key: "linear", name: "Linear", kind: "integration" },
  }),
  item(6, { type: "dynamic_tool", toolName: "Read", parentItemId: "parent" }),
  item(6, { type: "dynamic_tool", toolName: "Read" }),
  item(6, { type: "command_execution", exitCode: 1 }),
  item(6, {
    type: "user_message",
    text: `Look at /srv/acme-app/src/a.ts\nwith sk-proj-abcdefghij1234567890 ${"y".repeat(1_500)}`,
  }),
  ...[2, 6].flatMap((turn) =>
    Array.from({ length: 6 }, () =>
      item(turn, { type: "assistant_message", text: "z".repeat(2_000) }),
    ),
  ),
  item(6, { type: "dynamic_tool", toolName: "t3-code.t3_thread_read", status: "running" }),
  item(5, { type: "dynamic_tool", toolName: "mcp__t3-code__t3_feedback", status: "running" }),
  item(6, { type: "dynamic_tool", toolName: "mcp__t3-code__t3_feedback", status: "failed" }),
  // The call making the card in the active run, as Claude names it and as OpenCode 2 does.
  item(6, { type: "dynamic_tool", toolName: "mcp__t3-code__t3_feedback", status: "running" }),
  item(6, { type: "dynamic_tool", toolName: "t3-code-thread_1_t3_feedback", status: "running" }),
];

it("says so when the report asks for more turns than a trace can hold", () => {
  const many = Array.from({ length: 81 }, (_, index) => run(index + 1));
  const trace = (turns: number) =>
    buildFeedbackTrace({
      runs: many,
      items: many.map((_, index) => item(index + 1, { type: "user_message", text: "Hi" })),
      turns,
      withText: true,
      sensitive: [],
      t3Tools: [],
      driverOf: () => undefined,
      submittingRunId: many.at(-1)!.id,
    });
  expect(trace(100)).toMatchObject({ turns: 80, textTurns: 80, truncated: true });
  expect(trace(80)).toMatchObject({ turns: 80, textTurns: 80, truncated: false });
});

const harness = Effect.gen(function* () {
  const mode = yield* Ref.make<AgentFeedbackMode>("auto");
  // As in the service: updates and snapshots share one lock, and a read outside the lock can
  // capture the settings and finish later. Arming `reading` makes the next read signal `begun`;
  // an unlocked read signals after capturing and returns what it captured only on `release`.
  const settingsLock = yield* Semaphore.make(1);
  const reading = yield* Ref.make<
    | { readonly begun: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
    | undefined
  >(undefined);
  const readSettings = Ref.get(mode).pipe(
    Effect.map((mode) => ({ ...DEFAULT_SERVER_SETTINGS, agentFeedback: { mode } })),
  );
  const unlockedRead = Effect.gen(function* () {
    const captured = yield* readSettings;
    const armed = yield* Ref.getAndSet(reading, undefined);
    if (armed !== undefined) {
      yield* Deferred.succeed(armed.begun, undefined);
      yield* Deferred.await(armed.release);
    }
    return captured;
  });
  const snapshotBegins = Ref.getAndSet(reading, undefined).pipe(
    Effect.flatMap((armed) =>
      armed === undefined ? Effect.void : Deferred.succeed(armed.begun, undefined),
    ),
  );
  const items = yield* Ref.make(turnItems);
  const telemetry = yield* Ref.make(true);
  const runId = yield* Ref.make(RunId.make("run:1"));
  const events = yield* Ref.make<ReadonlyArray<readonly [string, unknown]>>([]);
  // Every feedback card the service records, in order.
  const cards = yield* Queue.unbounded<CardRecord>();
  // The cards as the thread stores them, each its latest record.
  const shown = yield* Ref.make(new Map<string, CardRecord>());
  // Faults and gates for card records, and a signal when an answer reads its card.
  const failRecords = yield* Ref.make(false);
  // Each gate holds the first record of its status until released.
  const recordGates = yield* Ref.make<
    ReadonlyArray<{
      readonly status: CardRecord["feedbackStatus"];
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    }>
  >([]);
  // The projection rows the store reads share the database, as in the server.
  const threads = Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const run of runs) {
        yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
          run_id: run.id,
          thread_id: threadId,
          ordinal: run.ordinal,
          provider: "codex",
          status: "running",
          requested_at: "2026-01-01T00:00:00.000Z",
          payload_json: "{}",
        })}`;
      }
      const project = (card: CardRecord) => sql`
        INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
          turn_item_id: card.turnItemId,
          thread_id: threadId,
          run_id: card.runId,
          ordinal: 0,
          type: "feedback_request",
          status:
            card.feedbackStatus === "pending"
              ? "waiting"
              : card.feedbackStatus === "sent"
                ? "completed"
                : "cancelled",
          updated_at: "2026-01-01T00:00:00.000Z",
          payload_json: "{}",
        })}
        ON CONFLICT (turn_item_id) DO UPDATE SET status = excluded.status
        WHERE orchestration_v2_projection_turn_items.status = 'waiting'`;
      return Layer.mock(Threads.ThreadManagementService)({
        dispatch: (command) =>
          Effect.gen(function* () {
            const card = command as CardRecord;
            if (card.feedbackStatus !== "pending" && (yield* Ref.get(failRecords))) {
              return yield* new FeedbackStorageError({ cause: "The card record failed." });
            }
            const gate = (yield* Ref.get(recordGates)).find(
              (candidate) => candidate.status === card.feedbackStatus,
            );
            if (gate !== undefined) {
              yield* Ref.update(recordGates, (gates) => gates.filter((other) => other !== gate));
              yield* Deferred.succeed(gate.entered, undefined);
              yield* Deferred.await(gate.release);
            }
            yield* Ref.update(shown, (cards) => {
              const existing = cards.get(card.turnItemId);
              // A decided card stays decided, as the orchestrator keeps it.
              return existing === undefined || existing.feedbackStatus === "pending"
                ? new Map(cards).set(card.turnItemId, card)
                : cards;
            });
            yield* project(card).pipe(Effect.orDie);
            yield* Queue.offer(cards, card);
            return {};
          }) as never,
        getThreadRecords: (_threadId, fields, filter) =>
          Effect.gen(function* () {
            const stored = yield* Ref.get(items);
            const wanted = fields as ReadonlyArray<string>;
            const selected =
              filter?.runIds === undefined
                ? filter?.latestRunLimit === undefined
                  ? runs
                  : runs.slice(-filter.latestRunLimit)
                : runs.filter((run) => filter.runIds?.includes(run.id));
            return {
              ...(wanted.includes("runs") ? { runs: selected } : {}),
              ...(wanted.includes("turnItems")
                ? {
                    turnItems: filter?.turnItemTypes?.includes("feedback_request")
                      ? [...(yield* Ref.get(shown)).values()].map(
                          ({ type: _record, commandId: _id, turnItemId, ...card }) => ({
                            ...card,
                            type: "feedback_request",
                            id: turnItemId,
                          }),
                        )
                      : stored.filter(
                          (item) =>
                            filter?.turnItemRunIds?.includes(item.runId) === true &&
                            filter.turnItemTypes?.includes(item.type) === true,
                        ),
                  }
                : {}),
            };
          }) as never,
        getThreadShell: () =>
          Ref.get(runId).pipe(
            Effect.map((activeRunId) => ({
              ...liveThreadShell(threadId, { activeRunId }),
              modelSelection: { instanceId, model: "gpt-5.5" },
              branch: "acme/secret-launch",
              worktreePath: "/srv/checkouts/acme-app-7",
            })),
          ),
      });
    }),
  );
  const layer = Feedback.layer(() => ["t3_thread_read", "t3_feedback"]).pipe(
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        threads,
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: unlockedRead,
          withSettingsSnapshot: (use) =>
            snapshotBegins.pipe(
              Effect.andThen(settingsLock.withPermits(1)(readSettings.pipe(Effect.flatMap(use)))),
            ),
        }),
        Layer.mock(Analytics.AnalyticsService)({
          record: (event, properties) =>
            Ref.get(telemetry).pipe(
              Effect.tap((on) =>
                on
                  ? Ref.update(events, (rows) => [...rows, [event, properties] as const])
                  : Effect.void,
              ),
            ),
        }),
        Layer.mock(Projects.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              title: "Acme Payments",
              workspaceRoot: "/srv/acme-app",
              repositoryIdentity: {
                canonicalKey: "github.com/acme/payments",
                locator: {
                  source: "git-remote",
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/payments.git",
                },
              },
            } as unknown as Project),
        }),
        Layer.mock(Providers.ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId,
              driver: "codex",
              auth: { status: "authenticated" },
              models: [{ slug: "gpt-5.5", isCustom: false }],
            } as unknown as ServerProvider,
          ]),
        }),
        SecureRandom.layerWebCrypto,
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return {
    mode,
    settingsLock,
    reading,
    items,
    telemetry,
    runId,
    events,
    cards,
    shown,
    failRecords,
    recordGates,
    layer,
  };
});

type CardRecord = Extract<
  Parameters<Threads.ThreadManagementService["Service"]["dispatch"]>[0],
  { readonly type: "feedback_request.record" }
>;

const awaiting = { status: "awaiting_approval", note: FEEDBACK_AWAITING_APPROVAL_NOTE };

/** Shows a requested report's card, which the call returns from at once. */
const show = (cards: Queue.Queue<CardRecord>, report: FeedbackInput) =>
  Effect.gen(function* () {
    const feedback = yield* Feedback.FeedbackService;
    expect(yield* feedback.submit(report, fromThread)).toEqual(awaiting);
    const card = yield* Queue.take(cards);
    expect(card.feedbackStatus).toBe("pending");
    return card;
  });

const answer = (card: CardRecord, reply: "send" | "decline", includeConversation = false) =>
  Effect.gen(function* () {
    const store = yield* Store.FeedbackStore;
    yield* store.answer({
      threadId,
      turnItemId: card.turnItemId,
      answer: reply,
      includeConversation,
    });
  });

/** Shows a requested report, sends it, and returns the card as shown and the stored report. */
const approved = (
  cards: Queue.Queue<CardRecord>,
  report: FeedbackInput,
  includeConversation = false,
) =>
  Effect.gen(function* () {
    const card = yield* show(cards, report);
    yield* answer(card, "send", includeConversation);
    const closed = yield* Queue.take(cards);
    const [stored] = yield* listFeedbackReports;
    return { card, closed, stored: stored! };
  });

const input = {
  kind: "bug" as const,
  subject: "t3_thread_read",
  expected: "Items for a completed thread.",
  actual: "No items.",
  workaround: "",
  userRequested: false,
  turns: 1,
};
const requested = { ...input, userRequested: true };
const decodeFeedbackInput = Schema.decodeUnknownSync(FeedbackInput);
const fromThread = { source: "mcp" as const, threadId };

it.effect("stores nothing and fails when agent feedback is off", () =>
  Effect.gen(function* () {
    const { mode, events, layer } = yield* harness;
    yield* Ref.set(mode, "off");
    yield* Effect.gen(function* () {
      const feedback = yield* Feedback.FeedbackService;
      const error = yield* Effect.flip(feedback.submit(input, fromThread));
      expect(error._tag).toBe("FeedbackOffError");
      expect(error.message).toContain("Settings > Labs");
      expect((yield* Effect.flip(listFeedbackReports))._tag).toBe("FeedbackOffError");
    }).pipe(Effect.provide(layer));
    expect(yield* Ref.get(events)).toEqual([]);
  }),
);

it.effect("scrubs the caller's private values and sends only the event contract", () =>
  Effect.gen(function* () {
    const { telemetry, events, cards, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const feedback = yield* Feedback.FeedbackService;
      yield* Ref.set(telemetry, false);
      const {
        stored: local,
        card,
        closed,
      } = yield* approved(
        cards,
        {
          kind: "other",
          subject: "mcp__t3-code__t3_thread_read",
          expected: `Reading /srv/checkouts/acme-app-7 on acme/secret-launch as ${NodeOS.userInfo().username}`,
          actual:
            "git@github.com:acme/payments.git in Acme Payments with sk-proj-abcdefghij1234567890",
          workaround: "x".repeat(400),
          userRequested: true,
          turns: 1,
        },
        true,
      );
      expect(local).toMatchObject({
        kind: "other",
        subject: "t3_thread_read",
        expected: "Reading [redacted] on [redacted] as [redacted]",
        actual: "[redacted] in [redacted] with [redacted]",
        workaround: "x".repeat(300),
        userRequested: true,
        threadId,
        source: "mcp",
        sent: false,
      });
      expect(yield* Ref.get(events)).toEqual([]);
      // Stored with telemetry off, but not sent: the card says so, and keeps only the outline.
      expect(local.trace).toEqual(card.conversationTrace);
      expect(closed).toMatchObject({ feedbackStatus: "cancelled", preview: card.preview });
      expect(closed.conversationTrace).toBeUndefined();

      yield* Ref.set(telemetry, true);
      const sent = yield* feedback.submit({ ...input, subject: "t3 thread show" }, fromThread);
      expect("sent" in sent && sent.sent).toBe(true);
      expect(yield* Ref.get(events)).toEqual([
        [
          "agent.feedback",
          {
            kind: "bug",
            subject: "t3 thread show",
            expected: input.expected,
            actual: input.actual,
            workaround: "",
            userRequested: false,
            trace: null,
            source: "mcp",
            provider: "codex",
            model: "gpt-5.5",
          },
        ],
      ]);
      yield* feedback.submit({ ...input, subject: " general " }, { source: "cli" });
      expect((yield* Ref.get(events))[1]).toEqual([
        "agent.feedback",
        {
          kind: "bug",
          subject: "general",
          expected: input.expected,
          actual: input.actual,
          workaround: "",
          userRequested: false,
          trace: null,
          source: "cli",
        },
      ]);
      yield* feedback.submit({ ...input, subject: "mcp__t3_code__t3_thread_read" }, fromThread);
      // Codex's second server, for T3 tools kept out of Code Mode, in both of its forms.
      for (const subject of [
        "t3-code-direct.t3_thread_read",
        "mcp__t3-code-direct__t3_thread_read",
      ])
        yield* feedback.submit({ ...input, subject }, { source: "cli" });
      expect(
        (yield* listFeedbackReports).map(({ subject, userRequested, sent, threadId }) => ({
          subject,
          userRequested,
          sent,
          threadId,
        })),
      ).toEqual([
        { subject: "t3_thread_read", userRequested: false, sent: true, threadId: null },
        { subject: "t3_thread_read", userRequested: false, sent: true, threadId: null },
        { subject: "t3_thread_read", userRequested: false, sent: true, threadId },
        { subject: "general", userRequested: false, sent: true, threadId: null },
        { subject: "t3 thread show", userRequested: false, sent: true, threadId },
        { subject: "t3_thread_read", userRequested: true, sent: false, threadId },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "allows 3 unprompted reports and 3 cards per turn, and 10 reports an hour outside a turn",
  () =>
    Effect.gen(function* () {
      const { mode, runId, events, cards, layer } = yield* harness;
      yield* Effect.gen(function* () {
        const feedback = yield* Feedback.FeedbackService;
        const limited = Effect.flip(feedback.submit(input, fromThread)).pipe(
          Effect.map((error) => error._tag),
        );
        for (const subject of ["", "acme payments roadmap", "mcp__other__t3_thread_read"]) {
          const error = yield* Effect.flip(feedback.submit({ ...input, subject }, fromThread));
          expect(error.message).toBe(
            "Set subject to the exact T3 tool name, the t3 command, or `general`.",
          );
        }
        const refused = (report: Partial<typeof input>, caller: Feedback.FeedbackCaller) =>
          Effect.flip(feedback.submit({ ...input, ...report }, caller)).pipe(
            Effect.map((error) => error.message),
          );
        // Only a thread can show the user a requested report to approve.
        expect(yield* refused({ userRequested: true }, { source: "cli" })).toBe(
          "A report the user asks for is shown to them for approval in their thread, and this call has no active thread turn, so nothing was sent.",
        );
        yield* Ref.set(mode, "on-request");
        expect(yield* refused({}, fromThread)).toBe(
          "Agent feedback is set to When I ask: send a report only when the user asks for one.",
        );
        expect(yield* refused({}, { source: "cli" })).toBe(
          "Agent feedback is set to When I ask: ask your agent in a thread to send it, so you can approve what is sent.",
        );
        yield* Ref.set(mode, "auto");
        expect(yield* Ref.get(events)).toEqual([]);
        yield* Effect.replicateEffect(feedback.submit(input, fromThread), 3, { discard: true });
        expect(yield* limited).toBe("FeedbackLimitError");
        // Cards count when shown, answered or not, and apart from unprompted reports.
        const [first] = yield* Effect.replicateEffect(show(cards, requested), 3);
        yield* answer(first!, "decline");
        expect(yield* refused({ userRequested: true }, fromThread)).toBe(
          "This turn already showed the user 3 agent feedback reports to approve; nothing was shown.",
        );
        // No cap per thread: each new turn has room again.
        for (const run of ["run:2", "run:3", "run:4", "run:5"]) {
          yield* Ref.set(runId, RunId.make(run));
          yield* Effect.replicateEffect(feedback.submit(input, fromThread), 3, { discard: true });
        }
        expect((yield* Effect.flip(feedback.submit(input, fromThread))).message).toBe(
          "This turn already sent 3 agent feedback reports; nothing was sent.",
        );
        // Outside a turn, such as `t3 feedback`, 10 an hour.
        const fromCli = { source: "cli" as const };
        yield* Effect.replicateEffect(feedback.submit(input, fromCli), 10, { discard: true });
        expect((yield* Effect.flip(feedback.submit(input, fromCli))).message).toBe(
          "This machine already sent 10 agent feedback reports outside a turn in the last hour; nothing was sent.",
        );
        yield* TestClock.adjust("1 hour");
        yield* feedback.submit(input, fromCli);
        expect(yield* listFeedbackReports).toHaveLength(26);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("a card holds the outline and the conversation, and sends the one the user picks", () =>
  Effect.gen(function* () {
    const { events, items, runId, cards, shown, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const feedback = yield* Feedback.FeedbackService;
      const unprompted = yield* feedback.submit(input, fromThread);
      expect("trace" in unprompted && unprompted.trace).toBeNull();

      yield* Ref.set(runId, RunId.make("run:6"));
      const fiveTurns = { ...requested, turns: 5 };
      const card = yield* show(cards, fiveTurns);
      const outline = card.preview.trace!;
      expect(outline).toMatchObject({ turns: 5, textTurns: 0, truncated: true });
      expect(outline.entries).toHaveLength(80);
      expect(JSON.stringify(outline)).not.toMatch(/Ask|Done|acme|linear|zzz/u);
      // Old tool calls give way first, so every turn keeps its user message.
      expect(outline.entries.filter((entry) => entry.type === "user").map((e) => e.turn)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(outline.entries.filter((entry) => entry.turn === 5 && entry.type === "tool")).toEqual([
        { turn: 5, type: "tool", tool: "t3_thread_read", outcome: "error", durationMs: 1_500 },
        { turn: 5, type: "tool", tool: "mcp", outcome: "ok" },
        { turn: 5, type: "tool", tool: "Read", outcome: "ok" },
        { turn: 5, type: "tool", tool: "shell", outcome: "error" },
        { turn: 5, type: "tool", tool: "t3_thread_read", outcome: "unfinished" },
        { turn: 5, type: "tool", tool: "t3_feedback", outcome: "error" },
      ]);
      expect(outline.entries.filter((entry) => entry.tool === "t3_feedback")).toEqual([
        { turn: 4, type: "tool", tool: "t3_feedback", outcome: "unfinished" },
        { turn: 5, type: "tool", tool: "t3_feedback", outcome: "error" },
      ]);

      // The conversation is the same outline with the scrubbed text of its turns, newest kept
      // first under 16 KB.
      const conversation = card.conversationTrace!;
      expect(Buffer.byteLength(JSON.stringify(conversation))).toBeLessThanOrEqual(16_000);
      expect(conversation.truncated).toBe(true);
      expect(
        conversation.entries.map(({ text: _text, ...entry }) => entry),
        "the same entries",
      ).toEqual(outline.entries);
      const texts = conversation.entries.flatMap((entry) =>
        entry.text === undefined ? [] : [[entry.turn, entry.text] as const],
      );
      expect(conversation.entries.find((entry) => entry.turn === 1)).toEqual({
        turn: 1,
        type: "user",
        length: 6,
      });
      expect(texts.filter(([turn]) => turn === 4).map(([, text]) => text)).toEqual([
        "Ask 5.",
        "Done in [redacted].",
      ]);
      expect(texts.filter(([turn]) => turn === 5)[0]?.[1]).toMatch(
        /^Look at \[redacted\]\nwith \[redacted\] y+$/u,
      );
      expect(texts.every(([, text]) => Array.from(text).length <= 1_000)).toBe(true);
      expect(conversation.textTurns).toBe(new Set(texts.map(([turn]) => turn)).size);

      // Off: the outline alone is stored and sent, and the card keeps only that.
      yield* answer(card, "send");
      const withoutText = yield* Queue.take(cards);
      expect(withoutText.preview).toEqual(card.preview);
      expect(withoutText.conversationTrace).toBeUndefined();
      // On: the conversation is.
      const included = yield* approved(cards, fiveTurns, true);
      expect(included.stored.trace).toEqual(included.card.conversationTrace);
      expect(included.closed.preview.trace).toEqual(included.card.conversationTrace);
      expect(included.closed.conversationTrace).toBeUndefined();
      expect([...(yield* Ref.get(shown)).values()].map((shown) => shown.feedbackStatus)).toEqual([
        "sent",
        "sent",
      ]);
      const sent = (yield* Ref.get(events)).slice(1).map(([, properties]) => properties);
      const stored = (yield* listFeedbackReports).slice(0, 2).toReversed();
      expect(stored.map((report) => report.trace)).toEqual([outline, conversation]);
      expect(sent.map((properties) => (properties as { trace: unknown }).trace)).toEqual([
        outline,
        conversation,
      ]);

      // Under the entry and byte caps, a message cut to 1,000 characters alone marks the text.
      yield* Ref.update(items, (all) => all.filter((item) => item.type !== "command_execution"));
      yield* Ref.set(runId, RunId.make("run:2"));
      const short = yield* show(cards, requested);
      expect(short.preview.trace?.truncated).toBe(false);
      expect(short.conversationTrace?.truncated).toBe(true);
      // Redaction lengthens 990 characters of addresses past the cap: that cut marks it too.
      yield* Ref.update(items, (all) => [
        ...all.filter(
          (item) =>
            !(item.type === "user_message" || item.type === "assistant_message") ||
            Array.from(item.text).length <= 1_000,
        ),
        item(6, { type: "user_message", text: "ops@a.io ".repeat(110) }),
      ]);
      const lengthened = yield* show(cards, requested);
      expect(lengthened.preview.trace?.truncated).toBe(false);
      expect(lengthened.conversationTrace?.truncated).toBe(true);
      // Turns with no message text give the card no conversation to include.
      yield* Ref.update(items, (all) => all.filter((item) => item.type === "dynamic_tool"));
      expect((yield* show(cards, requested)).conversationTrace).toBeUndefined();

      // The outline covers at least 5 started turns, more when the agent says the problem spans
      // more, up to the thread's; the conversation covers the turns the agent gave, oldest text
      // dropped first to fit.
      yield* Ref.set(items, turnItems);
      const { turns: _omitted, ...omitted } = requested;
      // The thread has 6 started turns; the byte cap leaves no room for the oldest one's text.
      const rows = [
        { run: "run:3", report: decodeFeedbackInput(omitted), turns: 5, text: [5] },
        { run: "run:3", report: { ...requested, turns: 3 }, turns: 5, text: [3, 4, 5] },
        { run: "run:4", report: { ...requested, turns: 6 }, turns: 6, text: [2, 3, 4, 5, 6] },
        { run: "run:4", report: { ...requested, turns: 20 }, turns: 6, text: [2, 3, 4, 5, 6] },
      ];
      for (const row of rows) {
        yield* Ref.set(runId, RunId.make(row.run));
        const shownCard = yield* show(cards, row.report);
        const conversation = shownCard.conversationTrace!;
        expect(shownCard.preview.trace!.turns).toBe(row.turns);
        expect(conversation).toMatchObject({ turns: row.turns, textTurns: row.text.length });
        expect([
          ...new Set(conversation.entries.flatMap((e) => (e.text === undefined ? [] : [e.turn]))),
        ]).toEqual(row.text);
      }
      expect(rows.map(({ report }) => report.turns)).toEqual([1, 3, 6, 20]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("returns as the card is shown, and stores and sends it only on Send, once", () =>
  Effect.gen(function* () {
    const { events, runId, cards, shown, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const nothingKept = Effect.gen(function* () {
        expect(yield* listFeedbackReports).toEqual([]);
        expect(yield* Ref.get(events)).toEqual([]);
      });

      // Decline: nothing is stored or sent, and the card drops the conversation it held.
      const declined = yield* show(cards, requested);
      expect(declined).toMatchObject({ runId: "run:1", nodeId: "node:1" });
      expect(declined.conversationTrace).toBeDefined();
      yield* nothingKept;
      yield* answer(declined, "decline");
      const closed = yield* Queue.take(cards);
      expect(closed).toMatchObject({ feedbackStatus: "declined", preview: declined.preview });
      expect(closed.conversationTrace).toBeUndefined();
      yield* nothingKept;
      // A decided card takes no second answer.
      expect((yield* Effect.flip(answer(declined, "send", true))).reason).toBe("already_answered");
      yield* nothingKept;

      // Only the thread that asked answers, and only its feedback cards.
      const store = yield* Store.FeedbackStore;
      for (const [thread, turnItemId] of [
        [ThreadId.make("thread:fork"), declined.turnItemId],
        [threadId, TurnItemId.make("turn-item:assistant-message:1")],
      ] as const) {
        expect(
          (yield* Effect.flip(store.answer({ threadId: thread, turnItemId, answer: "send" })))
            .reason,
        ).toBe("not_found");
      }

      // Send: exactly the shown preview is stored and sent, marked as requested.
      const { card, closed: sentCard, stored } = yield* approved(cards, requested);
      expect(sentCard.feedbackStatus).toBe("sent");
      const [[, properties]] = (yield* Ref.get(events)) as [[string, Record<string, unknown>]];
      for (const kept of [properties, stored]) {
        expect({
          kind: kept?.kind,
          subject: kept?.subject,
          expected: kept?.expected,
          actual: kept?.actual,
          workaround: kept?.workaround,
          trace: kept?.trace,
        }).toEqual(card.preview);
      }
      expect(properties).toMatchObject({ userRequested: true, provider: "codex" });

      // Two answers at once, from two clients or a double tap: exactly one takes effect.
      for (const [turn, replies] of [
        ["run:2", ["send", "send"]],
        ["run:3", ["send", "decline"]],
        ["run:4", ["decline", "send"]],
      ] as const) {
        yield* Ref.set(runId, RunId.make(turn));
        const raced = yield* show(cards, requested);
        const before = (yield* listFeedbackReports).length;
        const results = yield* Effect.all(
          replies.map((reply) => Effect.result(answer(raced, reply))),
          { concurrency: "unbounded" },
        );
        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        expect(results.find((result) => result._tag === "Failure")).toMatchObject({
          failure: { reason: "already_answered" },
        });
        const status = (yield* Ref.get(shown)).get(raced.turnItemId)?.feedbackStatus;
        expect((yield* listFeedbackReports).length - before).toBe(status === "sent" ? 1 : 0);
        yield* Queue.take(cards);
        expect(yield* Queue.size(cards)).toBe(0);
      }
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("Send works after the turn stopped, while a later turn runs, and after a restart", () =>
  Effect.gen(function* () {
    const { runId, events, cards, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const card = yield* show(cards, requested);
      // The user stopped the turn, and a later one is running.
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted'
        WHERE run_id = ${card.runId}`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
        turn_item_id: "interrupt-request",
        thread_id: threadId,
        run_id: card.runId,
        ordinal: 1,
        type: "run_interrupt_request",
        status: "completed",
        updated_at: "2026-01-01T00:00:00.000Z",
        payload_json: "{}",
      })}`;
      yield* Ref.set(runId, RunId.make("run:2"));
      // A store started after the card was shown, as after a restart, answers from the card.
      yield* answer(card, "send", true).pipe(Effect.provide(Store.layer));
      expect((yield* Queue.take(cards)).feedbackStatus).toBe("sent");
      const [stored] = yield* listFeedbackReports;
      expect(stored).toMatchObject({ trace: card.conversationTrace, sent: true });
      expect(yield* Ref.get(events)).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("Send refuses while Off and closes the card; When I ask and Automatic allow it", () =>
  Effect.gen(function* () {
    const { mode, events, cards, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const off = yield* show(cards, requested);
      yield* Ref.set(mode, "off");
      expect((yield* Effect.flip(answer(off, "send", true))).reason).toBe("feedback_off");
      const closed = yield* Queue.take(cards);
      expect(closed.feedbackStatus).toBe("cancelled");
      expect(closed.conversationTrace).toBeUndefined();
      yield* Ref.set(mode, "auto");
      expect(yield* listFeedbackReports).toEqual([]);
      expect(yield* Ref.get(events)).toEqual([]);

      const onRequest = yield* show(cards, requested);
      yield* Ref.set(mode, "on-request");
      yield* answer(onRequest, "send");
      expect((yield* Queue.take(cards)).feedbackStatus).toBe("sent");
      expect(yield* Ref.get(events)).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a report stored before its card was settled settles the card on the next answer", () =>
  Effect.gen(function* () {
    const { telemetry, events, cards, shown, failRecords, runId, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const status = (card: CardRecord) =>
        Ref.get(shown).pipe(Effect.map((all) => all.get(card.turnItemId)?.feedbackStatus));
      // The report is stored and sent, then recording the card fails, as a crash would leave it.
      const sentCard = yield* show(cards, requested);
      yield* Ref.set(failRecords, true);
      expect(yield* Effect.result(answer(sentCard, "send", true))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "record_failed" },
      });
      expect(yield* listFeedbackReports).toMatchObject([
        { trace: sentCard.conversationTrace, sent: true },
      ]);
      expect(yield* status(sentCard)).toBe("pending");
      yield* Ref.set(failRecords, false);
      // Either answer, from a store started after the fault, settles it from the stored report.
      yield* answer(sentCard, "decline").pipe(Effect.provide(Store.layer));
      const settled = yield* Queue.take(cards);
      expect(settled).toMatchObject({
        feedbackStatus: "sent",
        preview: { ...sentCard.preview, trace: sentCard.conversationTrace },
      });
      expect(settled.conversationTrace).toBeUndefined();
      expect((yield* Effect.flip(answer(sentCard, "send"))).reason).toBe("already_answered");
      expect(yield* Ref.get(events)).toHaveLength(1);
      expect(yield* listFeedbackReports).toHaveLength(1);

      // Stored but not sent: the card closes unsent, with the outline only.
      yield* Ref.set(runId, RunId.make("run:2"));
      yield* Ref.set(telemetry, false);
      const keptCard = yield* show(cards, requested);
      yield* Ref.set(failRecords, true);
      expect(yield* Effect.result(answer(keptCard, "send", true))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "record_failed" },
      });
      yield* Ref.set(failRecords, false);
      yield* answer(keptCard, "send");
      const closed = yield* Queue.take(cards);
      expect(closed).toMatchObject({ feedbackStatus: "cancelled", preview: keptCard.preview });
      expect(closed.conversationTrace).toBeUndefined();
      expect(yield* listFeedbackReports).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a report handed to telemetry heals as sent even if the sent write fails", () =>
  Effect.gen(function* () {
    const { events, cards, failRecords, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const card = yield* show(cards, requested);
      // Every write of `sent` fails, and so does the card record after the hand-off.
      yield* sql`CREATE TRIGGER fail_sent_write BEFORE UPDATE OF sent ON agent_feedback
        BEGIN SELECT RAISE(ABORT, 'The sent write failed.'); END`;
      yield* Ref.set(failRecords, true);
      expect(yield* Effect.result(answer(card, "send"))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "record_failed" },
      });
      expect(yield* Ref.get(events)).toHaveLength(1);
      yield* sql`DROP TRIGGER fail_sent_write`;
      yield* Ref.set(failRecords, false);
      // The report left the machine, so the next answer settles the card as sent.
      yield* answer(card, "decline");
      expect((yield* Queue.take(cards)).feedbackStatus).toBe("sent");
      expect(yield* listFeedbackReports).toMatchObject([{ sent: true }]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a card is shown while an answer waits for the settings lock", () =>
  Effect.gen(function* () {
    const { settingsLock, reading, events, cards, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const card = yield* show(cards, requested);
      // Something else holds the settings lock for a long time, as an agent uninstall can.
      const holding = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const holder = yield* settingsLock
        .withPermits(1)(
          Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(done))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(holding);
      const begun = yield* Deferred.make<void>();
      yield* Ref.set(reading, { begun, release: yield* Deferred.make<void>() });
      const parked = yield* Effect.forkChild(answer(card, "send"));
      yield* Deferred.await(begun);
      // An agent's request for another card does not wait behind the parked answer.
      yield* show(cards, requested);
      yield* Deferred.succeed(done, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(parked);
      expect((yield* Queue.take(cards)).feedbackStatus).toBe("sent");
      expect(yield* Ref.get(events)).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a Send refused while Off settles the card before a later Send can store it", () =>
  Effect.gen(function* () {
    const { mode, events, cards, shown, recordGates, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const gate = (status: CardRecord["feedbackStatus"]) =>
        Effect.gen(function* () {
          const held = {
            status,
            entered: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          yield* Ref.update(recordGates, (gates) => [...gates, held]);
          return held;
        });
      const card = yield* show(cards, requested);
      // The first Send is refused while Off and is held as it closes the card.
      yield* Ref.set(mode, "off");
      const closing = yield* gate("cancelled");
      const refused = yield* Effect.forkChild(Effect.result(answer(card, "send", true)));
      yield* Deferred.await(closing.entered);
      // Agent feedback is turned back on, and a second Send would be held as it marks the card
      // sent, after storing and sending its report.
      yield* Ref.set(mode, "auto");
      const marking = yield* gate("sent");
      const second = yield* Effect.forkChild(Effect.result(answer(card, "send", true)));
      const reachedSent = yield* Effect.forkChild(
        Deferred.await(marking.entered).pipe(Effect.timeoutOption("1 second")),
      );
      yield* TestClock.adjust("1 second");
      // The second Send waits for the first to finish, so it never stores a report.
      expect((yield* Fiber.join(reachedSent))._tag).toBe("None");
      yield* Deferred.succeed(closing.release, undefined);
      yield* Deferred.succeed(marking.release, undefined);
      expect(yield* Fiber.join(refused)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "feedback_off" },
      });
      expect(yield* Fiber.join(second)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "already_answered" },
      });
      expect((yield* Ref.get(shown)).get(card.turnItemId)?.feedbackStatus).toBe("cancelled");
      expect(yield* listFeedbackReports).toEqual([]);
      expect(yield* Ref.get(events)).toEqual([]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a mode switch under way when a report is stored wins", () =>
  Effect.gen(function* () {
    const { mode, settingsLock, reading, events, cards, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const feedback = yield* Feedback.FeedbackService;
      const nothingKept = Effect.gen(function* () {
        yield* Ref.set(mode, "auto");
        expect(yield* listFeedbackReports).toEqual([]);
        expect(yield* Ref.get(events)).toEqual([]);
      });
      /**
       * Holds a switch to `to` mid-write under the settings lock, runs `start` until storing reads
       * the settings, then lets the switch finish. A read outside the lock has captured the old
       * mode by then, and returns it only after the switch.
       */
      const switchDuring = <A, E, R>(to: AgentFeedbackMode, start: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          const updating = yield* Deferred.make<void>();
          const update = yield* settingsLock
            .withPermits(1)(
              Deferred.succeed(updating, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(Ref.set(mode, to)),
              ),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(updating);
          const begun = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Ref.set(reading, { begun, release });
          const call = yield* Effect.forkChild(start);
          yield* Deferred.await(begun);
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(update);
          yield* Deferred.succeed(release, undefined);
          return yield* Effect.result(Fiber.join(call));
        });

      // Automatic to Off while Send stores the card's report: nothing kept, the card closes.
      const card = yield* show(cards, requested);
      expect(yield* switchDuring("off", answer(card, "send"))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "AgentFeedbackRequestError", reason: "feedback_off" },
      });
      expect((yield* Queue.take(cards)).feedbackStatus).toBe("cancelled");
      yield* nothingKept;

      // Automatic to When I ask while an unprompted report is on its way: refused as itself.
      expect(yield* switchDuring("on-request", feedback.submit(input, fromThread))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "FeedbackNotRequestedError" },
      });
      yield* nothingKept;
    }).pipe(Effect.provide(layer));
  }),
);

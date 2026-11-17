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
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Analytics from "../telemetry/AnalyticsService.ts";
import * as Approvals from "./FeedbackApprovals.ts";
import type { FeedbackInput } from "./FeedbackReport.ts";
import { listFeedbackReports } from "./FeedbackList.ts";
import * as Feedback from "./FeedbackService.ts";

const threadId = ThreadId.make("thread:feedback");
const instanceId = ProviderInstanceId.make("work-codex");

const at = (ms: number) => DateTime.makeUnsafe(ms);
const run = (ordinal: number, started = true) =>
  ({
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    providerInstanceId: instanceId,
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
];

const harness = Effect.gen(function* () {
  const mode = yield* Ref.make<AgentFeedbackMode>("auto");
  const items = yield* Ref.make(turnItems);
  const telemetry = yield* Ref.make(true);
  const runId = yield* Ref.make(RunId.make("run:1"));
  const events = yield* Ref.make<ReadonlyArray<readonly [string, unknown]>>([]);
  // Every feedback card the service records, in order.
  const cards = yield* Queue.unbounded<CardRecord>();
  // The cards as the thread stores them, and the runs a stop has ended.
  const shown = yield* Ref.make(new Map<string, CardRecord>());
  const stopped = yield* Ref.make(new Set<string>());
  const threads = Layer.mock(Threads.ThreadManagementService)({
    dispatch: (command) =>
      Ref.update(shown, (cards) => {
        const card = command as CardRecord;
        const existing = cards.get(card.turnItemId);
        // A decided card stays decided, as the orchestrator keeps it.
        return existing === undefined || existing.feedbackStatus === "pending"
          ? new Map(cards).set(card.turnItemId, card)
          : cards;
      }).pipe(Effect.andThen(Queue.offer(cards, command as CardRecord)), Effect.as({} as never)),
    getThreadRecords: (_threadId, fields, filter) =>
      Effect.gen(function* () {
        const stored = yield* Ref.get(items);
        const ended = yield* Ref.get(stopped);
        const wanted = fields as ReadonlyArray<string>;
        const selected =
          filter?.runIds === undefined
            ? filter?.latestRunLimit === undefined
              ? runs
              : runs.slice(-filter.latestRunLimit)
            : runs.filter((run) => filter.runIds?.includes(run.id));
        return {
          ...(wanted.includes("runs")
            ? {
                runs: selected.map((run) => ({
                  ...run,
                  status: ended.has(run.id) ? "interrupted" : "running",
                })),
              }
            : {}),
          ...(wanted.includes("turnItems")
            ? {
                turnItems: filter?.turnItemTypes?.includes("feedback_request")
                  ? [...(yield* Ref.get(shown)).values()].map((card) => ({
                      type: "feedback_request",
                      id: card.turnItemId,
                      runId: card.runId,
                      feedbackStatus: card.feedbackStatus,
                    }))
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
  const layer = Feedback.layer(() => ["t3_thread_read"]).pipe(
    Layer.provideMerge(Approvals.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        threads,
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Ref.get(mode).pipe(
            Effect.map((mode) => ({ ...DEFAULT_SERVER_SETTINGS, agentFeedback: { mode } })),
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
              models: [{ slug: "gpt-5.5", isCustom: false }],
            } as unknown as ServerProvider,
          ]),
        }),
        SecureRandom.layerWebCrypto,
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return { mode, items, telemetry, runId, events, cards, stopped, layer };
});

type CardRecord = Extract<
  Parameters<Threads.ThreadManagementService["Service"]["dispatch"]>[0],
  { readonly type: "feedback_request.record" }
>;

/** Submits a requested report, answers its card, and returns the outcome with the shown card. */
const answered = (
  cards: Queue.Queue<CardRecord>,
  report: FeedbackInput,
  answer: "send" | "decline",
) =>
  Effect.gen(function* () {
    const feedback = yield* Feedback.FeedbackService;
    const approvals = yield* Approvals.FeedbackApprovals;
    const call = yield* feedback.submit(report, fromThread).pipe(Effect.forkChild);
    // Skips the decided records of earlier cards.
    let card = yield* Queue.take(cards);
    while (card.feedbackStatus !== "pending") card = yield* Queue.take(cards);
    yield* approvals.answer({ threadId, turnItemId: card.turnItemId, answer });
    return { outcome: yield* Fiber.join(call), card };
  });

/** A requested report the user approved. */
const approved = (cards: Queue.Queue<CardRecord>, report: FeedbackInput) =>
  answered(cards, report, "send").pipe(
    Effect.flatMap(({ outcome }) =>
      "approved" in outcome ? Effect.die("The report was not approved.") : Effect.succeed(outcome),
    ),
  );

const input = {
  kind: "bug" as const,
  subject: "t3_thread_read",
  expected: "Items for a completed thread.",
  actual: "No items.",
  workaround: "",
  userRequested: false,
  includeTurns: 0,
};
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
      const local = yield* approved(cards, {
        kind: "other",
        subject: "mcp__t3-code__t3_thread_read",
        expected: `Reading /srv/checkouts/acme-app-7 on acme/secret-launch as ${NodeOS.userInfo().username}`,
        actual:
          "git@github.com:acme/payments.git in Acme Payments with sk-proj-abcdefghij1234567890",
        workaround: "x".repeat(400),
        userRequested: true,
        includeTurns: 0,
      });
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
  "allows 3 reports of each kind per turn, and 10 an hour outside a turn, counting no refusal",
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
        expect(yield* refused({ includeTurns: 2 }, fromThread)).toBe(
          "Conversation text goes only on a report the user asked for (userRequested).",
        );
        // Only a thread can show the user a requested report to approve.
        expect(yield* refused({ includeTurns: 1, userRequested: true }, { source: "cli" })).toBe(
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
        // Unprompted reports leave a requested one its own room in the turn.
        yield* Effect.replicateEffect(approved(cards, { ...input, userRequested: true }), 3, {
          discard: true,
        });
        const requested = yield* Effect.flip(
          feedback.submit({ ...input, userRequested: true }, fromThread),
        );
        expect(requested.message).toBe(
          "This turn already sent 3 agent feedback reports of this kind; nothing was sent.",
        );
        // No cap per thread: each new turn has room again.
        for (const run of ["run:2", "run:3", "run:4", "run:5"]) {
          yield* Ref.set(runId, RunId.make(run));
          yield* Effect.replicateEffect(feedback.submit(input, fromThread), 3, { discard: true });
        }
        // Outside a turn, such as `t3 feedback`, 10 an hour.
        const fromCli = { source: "cli" as const };
        yield* Effect.replicateEffect(feedback.submit(input, fromCli), 10, { discard: true });
        expect((yield* Effect.flip(feedback.submit(input, fromCli))).message).toBe(
          "This machine already sent 10 agent feedback reports outside a turn in the last hour; nothing was sent.",
        );
        yield* TestClock.adjust("1 hour");
        yield* feedback.submit(input, fromCli);
        expect(yield* listFeedbackReports).toHaveLength(29);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("attaches a trace only to requested reports, with text only for includeTurns", () =>
  Effect.gen(function* () {
    const { events, items, runId, cards, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const feedback = yield* Feedback.FeedbackService;
      const unprompted = yield* feedback.submit(input, fromThread);
      expect("trace" in unprompted && unprompted.trace).toBeNull();

      const requested = { ...input, userRequested: true };
      const outline = (yield* approved(cards, requested)).trace!;
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
      ]);

      const withText = (yield* approved(cards, { ...requested, includeTurns: 2 })).trace!;
      expect(Buffer.byteLength(JSON.stringify(withText))).toBeLessThanOrEqual(16_000);
      expect(withText).toMatchObject({ textTurns: 2 });
      const texts = withText.entries.flatMap((entry) =>
        entry.text === undefined ? [] : [[entry.turn, entry.text] as const],
      );
      expect(texts.slice(0, 2)).toEqual([
        [4, "Ask 5."],
        [4, "Done in [redacted]."],
      ]);
      expect(texts.filter(([turn]) => turn === 5)[0]?.[1]).toMatch(
        /^Look at \[redacted\]\nwith \[redacted\] y+$/u,
      );
      expect(texts.every(([, text]) => Array.from(text).length <= 1_000)).toBe(true);

      // Past 16 KB, the oldest text goes first.
      yield* Ref.set(runId, RunId.make("run:2"));
      const capped = (yield* approved(cards, { ...requested, includeTurns: 5 })).trace!;
      expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(16_000);
      expect(capped.truncated).toBe(true);
      expect(capped.entries.find((entry) => entry.turn === 1)).toEqual({
        turn: 1,
        type: "user",
        length: 6,
      });
      const recent = (trace: typeof capped) => trace.entries.filter((entry) => entry.turn >= 4);
      expect(recent(capped)).toEqual(recent(withText));

      const sent = (yield* Ref.get(events)).map(([, properties]) => properties);
      const stored = (yield* listFeedbackReports).map((report) => report.trace).toReversed();
      expect(stored).toEqual(sent.map((properties) => (properties as { trace: unknown }).trace));

      // Under the entry and byte caps, a message cut to 1,000 characters alone marks the trace.
      yield* Ref.update(items, (all) => all.filter((item) => item.type !== "command_execution"));
      yield* Ref.set(runId, RunId.make("run:3"));
      expect((yield* approved(cards, requested)).trace?.truncated).toBe(false);
      expect((yield* approved(cards, { ...requested, includeTurns: 1 })).trace).toMatchObject({
        textTurns: 1,
        truncated: true,
      });
      // Redaction lengthens 990 characters of addresses past the cap: that cut marks it too.
      yield* Ref.update(items, (all) => [
        ...all.filter(
          (item) =>
            !(item.type === "user_message" || item.type === "assistant_message") ||
            Array.from(item.text).length <= 1_000,
        ),
        item(6, { type: "user_message", text: "ops@a.io ".repeat(110) }),
      ]);
      expect((yield* approved(cards, { ...requested, includeTurns: 1 })).trace).toMatchObject({
        textTurns: 1,
        truncated: true,
      });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "stores and sends a requested report only as shown, and only once the user approves",
  () =>
    Effect.gen(function* () {
      const { events, runId, cards, layer } = yield* harness;
      yield* Effect.gen(function* () {
        const feedback = yield* Feedback.FeedbackService;
        const approvals = yield* Approvals.FeedbackApprovals;
        const requested = { ...input, userRequested: true, includeTurns: 1 };
        const nothingKept = Effect.gen(function* () {
          expect(yield* listFeedbackReports).toEqual([]);
          expect(yield* Ref.get(events)).toEqual([]);
        });

        // Decline: nothing is stored, sent or counted, then or later.
        const call = yield* feedback.submit(requested, fromThread).pipe(Effect.forkChild);
        const shown = yield* Queue.take(cards);
        expect(shown).toMatchObject({
          feedbackStatus: "pending",
          runId: "run:1",
          nodeId: "node:1",
        });
        yield* nothingKept;
        yield* approvals.answer({ threadId, turnItemId: shown.turnItemId, answer: "decline" });
        expect(yield* Fiber.join(call)).toEqual({
          approved: false,
          status: "declined",
          note: "The user did not approve this report, so nothing was sent. Do not send it, or any part of it, another way.",
        });
        expect((yield* Queue.take(cards)).feedbackStatus).toBe("declined");
        yield* nothingKept;
        // A decided card takes no second answer.
        const late = yield* Effect.flip(
          approvals.answer({ threadId, turnItemId: shown.turnItemId, answer: "send" }),
        );
        expect(late._tag).toBe("AgentFeedbackRequestError");

        // No answer in time: the card closes and nothing is kept.
        const unanswered = yield* feedback.submit(requested, fromThread).pipe(Effect.forkChild);
        yield* Queue.take(cards);
        yield* TestClock.adjust("10 minutes");
        expect(yield* Fiber.join(unanswered)).toMatchObject({
          approved: false,
          status: "timed_out",
        });
        expect((yield* Queue.take(cards)).feedbackStatus).toBe("cancelled");
        yield* nothingKept;

        // Send: exactly the shown preview is stored and sent, marked as requested.
        const { outcome, card } = yield* answered(cards, requested, "send");
        expect(outcome).toMatchObject({ userRequested: true, threadId, sent: true });
        expect((yield* Queue.take(cards)).feedbackStatus).toBe("sent");
        const [[, properties]] = (yield* Ref.get(events)) as [[string, Record<string, unknown>]];
        const [stored] = yield* listFeedbackReports;
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
        expect(properties.userRequested).toBe(true);

        // Unprompted reports in Automatic mode go out with no card. The declined and timed-out
        // reports did not count: this turn still takes two more.
        yield* Effect.replicateEffect(feedback.submit(input, fromThread), 2, { discard: true });
        expect(yield* Queue.size(cards)).toBe(0);
        expect((yield* listFeedbackReports).map((report) => report.userRequested)).toEqual([
          false,
          false,
          true,
        ]);
        yield* Ref.set(runId, RunId.make("run:2"));
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("sends nothing approved after the turn stopped or feedback was turned off", () =>
  Effect.gen(function* () {
    const { mode, events, cards, stopped, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const feedback = yield* Feedback.FeedbackService;
      const approvals = yield* Approvals.FeedbackApprovals;
      const requested = { ...input, userRequested: true };
      const nothingKept = Effect.gen(function* () {
        yield* Ref.set(mode, "auto");
        expect(yield* listFeedbackReports).toEqual([]);
        expect(yield* Ref.get(events)).toEqual([]);
      });

      // The turn stops while the call still waits: Send is refused, and the card times out.
      const call = yield* feedback.submit(requested, fromThread).pipe(Effect.forkChild);
      const shown = yield* Queue.take(cards);
      yield* Ref.update(stopped, (runs) => new Set(runs).add(shown.runId));
      const refused = yield* Effect.flip(
        approvals.answer({ threadId, turnItemId: shown.turnItemId, answer: "send" }),
      );
      expect(refused.message).toBe(
        "The agent that asked has stopped, so this report can't be sent.",
      );
      yield* TestClock.adjust("10 minutes");
      expect(yield* Fiber.join(call)).toMatchObject({ approved: false, status: "timed_out" });
      expect((yield* Queue.take(cards)).feedbackStatus).toBe("cancelled");
      yield* nothingKept;
      yield* Ref.set(stopped, new Set());

      // Off between showing the card and Send: nothing is stored or sent, and the card closes.
      const turnedOff = yield* feedback.submit(requested, fromThread).pipe(Effect.forkChild);
      const second = yield* Queue.take(cards);
      yield* Ref.set(mode, "off");
      yield* approvals.answer({ threadId, turnItemId: second.turnItemId, answer: "send" });
      expect((yield* Effect.flip(Fiber.join(turnedOff)))._tag).toBe("FeedbackOffError");
      expect((yield* Queue.take(cards)).feedbackStatus).toBe("cancelled");
      yield* nothingKept;
    }).pipe(Effect.provide(layer));
  }),
);

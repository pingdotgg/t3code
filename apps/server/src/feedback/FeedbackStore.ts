// Stores agent feedback reports and shows the cards of requested ones. A card is answered from
// what it recorded, so it stays answerable after its turn ends and after a restart.
import {
  type AgentFeedbackAnswerInput,
  type AgentFeedbackMode,
  type AgentFeedbackPreview,
  type AgentFeedbackRequestStatus,
  AgentFeedbackRequestError,
  type AgentFeedbackTrace,
  CommandId,
  type NodeId,
  type RunId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Analytics from "../telemetry/AnalyticsService.ts";
import { type ProviderDimensions, providerDimensions } from "../telemetry/ProviderDimensions.ts";
import {
  FeedbackLimitError,
  FeedbackNotRequestedError,
  MAX_REPORTS_OUTSIDE_TURNS_PER_HOUR,
  MAX_REPORTS_PER_TURN,
  FeedbackOffError,
  type FeedbackReport,
  FeedbackStorageError,
  FeedbackTrace,
  type FeedbackSource,
} from "./FeedbackReport.ts";

const CARD_PREFIX = "turn-item:feedback-request:";

/** A requested report waiting for the user's answer, shown in its run. */
export interface FeedbackCard {
  readonly reportId: string;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly preview: AgentFeedbackPreview;
  readonly conversationTrace: AgentFeedbackTrace | null;
}

export interface UnpromptedReport {
  readonly id: string;
  readonly preview: AgentFeedbackPreview;
  readonly source: FeedbackSource;
  readonly threadId: ThreadId | null;
  readonly runId: RunId | null;
  readonly dimensions: Partial<ProviderDimensions>;
}

export class FeedbackStore extends Context.Service<
  FeedbackStore,
  {
    /** Stores and sends a report nobody has to approve. */
    readonly store: (
      report: UnpromptedReport,
    ) => Effect.Effect<
      FeedbackReport,
      FeedbackLimitError | FeedbackOffError | FeedbackNotRequestedError | FeedbackStorageError
    >;
    /** Shows a requested report's card. Nothing is stored or sent until the user answers it. */
    readonly showCard: (
      card: FeedbackCard,
    ) => Effect.Effect<void, FeedbackLimitError | FeedbackStorageError>;
    /** Send stores and sends what the card shows; either answer closes it, once. */
    readonly answer: (
      input: AgentFeedbackAnswerInput,
    ) => Effect.Effect<void, AgentFeedbackRequestError>;
  }
>()("t3/feedback/FeedbackStore") {}

const storageError = (cause: unknown) => new FeedbackStorageError({ cause });
const TraceJson = Schema.NullOr(Schema.fromJsonString(FeedbackTrace));
const encodeTrace = Schema.encodeEffect(TraceJson);
const decodeTrace = Schema.decodeUnknownEffect(TraceJson);

/** The mode rule: nothing while Off, and only approved reports while When I ask. */
export const allowedBy = (
  mode: AgentFeedbackMode,
  userRequested: boolean,
  source: FeedbackSource,
): Effect.Effect<void, FeedbackOffError | FeedbackNotRequestedError> =>
  mode === "off"
    ? Effect.fail(new FeedbackOffError({}))
    : mode === "on-request" && !userRequested
      ? Effect.fail(new FeedbackNotRequestedError({ source }))
      : Effect.void;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* Threads.ThreadManagementService;
  const settings = yield* Settings.ServerSettingsService;
  const analytics = yield* Analytics.AnalyticsService;
  const providers = yield* Providers.ProviderRegistry;
  // Serializes the limit checks with their writes. Held only after any settings wait, so an answer
  // stalled on the settings lock never holds up a card or an unprompted report.
  const lock = yield* Semaphore.make(1);
  // Serializes answers, each from its claim through settling its card. Order: answers, settings,
  // SQL. Nothing that holds the settings lock or `lock` takes this one.
  const answering = yield* Semaphore.make(1);

  const record = (
    card: Omit<FeedbackCard, "conversationTrace">,
    feedbackStatus: AgentFeedbackRequestStatus,
    conversationTrace?: AgentFeedbackTrace,
  ) =>
    threads
      .dispatch({
        type: "feedback_request.record",
        commandId: CommandId.make(`feedback-request:${card.reportId}:${feedbackStatus}`),
        threadId: card.threadId,
        runId: card.runId,
        nodeId: card.nodeId,
        turnItemId: TurnItemId.make(`${CARD_PREFIX}${card.reportId}`),
        preview: card.preview,
        ...(conversationTrace === undefined ? {} : { conversationTrace }),
        feedbackStatus,
      })
      .pipe(Effect.mapError(storageError));

  /** The unprompted report the next one would pass the limit of, or undefined. */
  const overLimit = Effect.fn("FeedbackStore.overLimit")(function* (runId: RunId | null) {
    if (runId !== null) {
      const [row] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM agent_feedback
        WHERE run_id = ${runId} AND user_requested = 0`;
      return (row?.count ?? 0) >= MAX_REPORTS_PER_TURN ? ("turn" as const) : undefined;
    }
    const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 1 }));
    const [row] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM agent_feedback
      WHERE run_id IS NULL AND created_at > ${since}`;
    return (row?.count ?? 0) >= MAX_REPORTS_OUTSIDE_TURNS_PER_HOUR ? ("hour" as const) : undefined;
  });

  /**
   * Inserts a report under the settings lock, so a switch to Off is wholly before or after it: a
   * read cannot return the mode an update is replacing. An unprompted report takes `lock` inside
   * it for its limit; a requested one is called under `answering`.
   */
  const insert = Effect.fn("FeedbackStore.insert")(function* (
    report: Omit<FeedbackReport, "sent">,
    runId: RunId | null,
  ) {
    const traceJson = yield* encodeTrace(report.trace).pipe(Effect.mapError(storageError));
    const write = (mode: AgentFeedbackMode) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!report.userRequested) {
            const limited = yield* overLimit(runId);
            if (limited !== undefined) return yield* new FeedbackLimitError({ scope: limited });
          }
          // Last before the insert: the mode can change while a card waits.
          yield* allowedBy(mode, report.userRequested, report.source);
          yield* sql`INSERT INTO agent_feedback ${sql.insert({
            id: report.id,
            thread_id: report.threadId,
            run_id: runId,
            created_at: report.createdAt,
            kind: report.kind,
            subject: report.subject,
            expected: report.expected,
            actual: report.actual,
            workaround: report.workaround,
            user_requested: report.userRequested ? 1 : 0,
            trace: traceJson,
            source: report.source,
            // Marked sent before the hand-off and cleared only on a refusal, so a delivery cut
            // short reads as sent.
            sent: 1,
          })}`;
        }),
      );
    yield* settings
      .withSettingsSnapshot(({ agentFeedback: { mode } }) =>
        report.userRequested ? write(mode) : lock.withPermit(write(mode)),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "FeedbackLimitError" ||
          error._tag === "FeedbackOffError" ||
          error._tag === "FeedbackNotRequestedError"
            ? error
            : storageError(error),
        ),
      );
  });

  /** Sends a stored report as the `agent.feedback` event; false when telemetry refuses it. */
  const deliver = Effect.fn("FeedbackStore.deliver")(function* (
    report: Omit<FeedbackReport, "sent">,
    dimensions: Partial<ProviderDimensions>,
  ) {
    const { kind, subject, expected, actual, workaround, trace, userRequested, source } = report;
    const sent = yield* analytics.record("agent.feedback", {
      kind,
      subject,
      expected,
      actual,
      workaround,
      trace,
      userRequested,
      source,
      ...dimensions,
    });
    if (!sent) {
      // A failed clear leaves the report reading as sent, on purpose: uncertain reads as sent.
      yield* sql`UPDATE agent_feedback SET sent = 0 WHERE id = ${report.id}`.pipe(
        Effect.mapError(storageError),
      );
    }
    return sent;
  });

  const store = Effect.fn("FeedbackStore.store")(function* ({
    preview,
    id,
    source,
    threadId,
    runId,
    dimensions,
  }: UnpromptedReport) {
    const report = {
      ...preview,
      userRequested: false,
      source,
      id,
      threadId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* insert(report, runId);
    return { ...report, sent: yield* deliver(report, dimensions) };
  });

  const showCard = Effect.fn("FeedbackStore.showCard")(function* (card: FeedbackCard) {
    yield* lock.withPermit(
      Effect.gen(function* () {
        const [shown] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${card.threadId} AND run_id = ${card.runId}
            AND type = 'feedback_request'`.pipe(Effect.mapError(storageError));
        if ((shown?.count ?? 0) >= MAX_REPORTS_PER_TURN) {
          return yield* new FeedbackLimitError({ scope: "cards" });
        }
        yield* record(card, "pending", card.conversationTrace ?? undefined);
      }),
    );
  });

  const answer = Effect.fn("FeedbackStore.answer")(function* (input: AgentFeedbackAnswerInput) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
      "agent_feedback.answer": input.answer,
    });
    const fail = (reason: AgentFeedbackRequestError["reason"]) =>
      Effect.fail(new AgentFeedbackRequestError({ reason }));
    const recordFailed = (cause: unknown) =>
      new AgentFeedbackRequestError({ reason: "record_failed", cause });
    const { turnItems } = yield* threads
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["feedback_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.mapError((cause) => new AgentFeedbackRequestError({ reason: "load_failed", cause })),
      );
    const item = turnItems.find((candidate) => candidate.id === input.turnItemId);
    // A fork lists the cards it inherited; only the thread that asked answers one.
    if (
      item?.type !== "feedback_request" ||
      item.threadId !== input.threadId ||
      item.runId === null ||
      item.nodeId === null ||
      !item.id.startsWith(CARD_PREFIX)
    ) {
      return yield* fail("not_found");
    }
    if (item.feedbackStatus !== "pending") return yield* fail("already_answered");
    const card = {
      reportId: item.id.slice(CARD_PREFIX.length),
      threadId: input.threadId,
      runId: item.runId,
      nodeId: item.nodeId,
    };
    // Settles the card with the trace it sent. Without one, it keeps only the outline.
    const settle = (status: AgentFeedbackRequestStatus, trace = item.preview.trace) =>
      record({ ...card, preview: { ...item.preview, trace } }, status);
    const { runs } = yield* threads
      .getThreadRecords(input.threadId, ["runs"], { runIds: [card.runId] })
      .pipe(
        Effect.mapError((cause) => new AgentFeedbackRequestError({ reason: "load_failed", cause })),
      );
    const run = runs.find((candidate) => candidate.id === card.runId);
    const providerList = yield* providers.getProviders;

    // One answer at a time, from the claim through settling the card, so no other answer can
    // settle it differently in between.
    yield* answering
      .withPermit(
        Effect.gen(function* () {
          const [waiting] = yield* sql<{ readonly waiting: number }>`
            SELECT 1 AS waiting FROM orchestration_v2_projection_turn_items
            WHERE turn_item_id = ${item.id} AND status = 'waiting'`;
          if (waiting === undefined) return yield* fail("already_answered");
          // Stored before its card was settled, by a crash or a failed record: settle it now. A
          // report not known to be refused reads as sent.
          const [stored] = yield* sql<{ readonly sent: number; readonly trace: string | null }>`
            SELECT sent, trace FROM agent_feedback WHERE id = ${card.reportId}`;
          if (stored !== undefined) {
            if (stored.sent !== 1) return yield* settle("cancelled");
            return yield* settle("sent", yield* decodeTrace(stored.trace));
          }
          if (input.answer === "decline") return yield* settle("declined");

          const trace =
            input.includeConversation === true && item.conversationTrace !== undefined
              ? item.conversationTrace
              : item.preview.trace;
          const report = {
            ...item.preview,
            trace,
            userRequested: true,
            source: "mcp" as const,
            id: card.reportId,
            threadId: input.threadId,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          };
          const off = yield* insert(report, card.runId).pipe(
            Effect.as(false),
            Effect.catchTags({ FeedbackOffError: () => Effect.succeed(true) }),
          );
          if (off) {
            yield* settle("cancelled");
            return yield* fail("feedback_off");
          }
          const sent = yield* deliver(
            report,
            run === undefined ? {} : providerDimensions(providerList, run.modelSelection),
          );
          // Telemetry off keeps the report on this machine, so the card says not sent.
          yield* sent ? settle("sent", trace) : settle("cancelled");
        }),
      )
      .pipe(
        Effect.catchTags({
          // A failed record leaves the card open; the next answer settles it from the report.
          FeedbackStorageError: (error) => Effect.fail(recordFailed(error)),
          SqlError: (error) => Effect.fail(recordFailed(error)),
          SchemaError: (error) => Effect.fail(recordFailed(error)),
          // A requested report is never over a limit or refused by When I ask.
          FeedbackLimitError: Effect.die,
          FeedbackNotRequestedError: Effect.die,
        }),
      );
  });

  return FeedbackStore.of({ store, showCard, answer });
});

export const layer = Layer.effect(FeedbackStore, make);

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

/** The card was answered, or its report stored, before this answer. */
class FeedbackAnsweredError extends Schema.TaggedError<FeedbackAnsweredError>()(
  "FeedbackAnsweredError",
  {},
) {}

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
const encodeTrace = Schema.encodeEffect(Schema.NullOr(Schema.fromJsonString(FeedbackTrace)));

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
  // Serializes each limit or answer check with its write. Taken after the settings lock, and
  // held across a card's dispatch, which never takes the settings lock.
  const lock = yield* Semaphore.make(1);

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

  /** The card still waits and its report was never stored. Read under the lock. */
  const stillWaiting = (reportId: string) =>
    sql<{ readonly waiting: number }>`
      SELECT 1 AS waiting FROM orchestration_v2_projection_turn_items
      WHERE turn_item_id = ${`${CARD_PREFIX}${reportId}`} AND status = 'waiting'
        AND NOT EXISTS (SELECT 1 FROM agent_feedback WHERE id = ${reportId})`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  const save = Effect.fn("FeedbackStore.save")(function* (
    preview: AgentFeedbackPreview,
    context: Omit<UnpromptedReport, "preview"> & { readonly userRequested: boolean },
  ) {
    const { userRequested } = context;
    const report = {
      ...preview,
      userRequested,
      source: context.source,
      id: context.id,
      threadId: context.threadId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    const traceJson = yield* encodeTrace(preview.trace).pipe(Effect.mapError(storageError));
    // Under the settings lock, so a switch to Off is either fully before this report or after
    // it: a read cannot return the mode an update is replacing. Order: settings, feedback, SQL.
    yield* settings
      .withSettingsSnapshot((current) =>
        lock.withPermit(
          sql.withTransaction(
            Effect.gen(function* () {
              if (userRequested) {
                if (!(yield* stillWaiting(context.id))) return yield* new FeedbackAnsweredError();
              } else {
                const limited = yield* overLimit(context.runId);
                if (limited !== undefined) return yield* new FeedbackLimitError({ scope: limited });
              }
              // Last before the insert: the mode can change while a card waits.
              yield* allowedBy(current.agentFeedback.mode, userRequested, context.source);
              yield* sql`INSERT INTO agent_feedback ${sql.insert({
                id: report.id,
                thread_id: report.threadId,
                run_id: context.runId,
                created_at: report.createdAt,
                kind: report.kind,
                subject: report.subject,
                expected: report.expected,
                actual: report.actual,
                workaround: report.workaround,
                user_requested: userRequested ? 1 : 0,
                trace: traceJson,
                source: report.source,
                sent: 0,
              })}`;
            }),
          ),
        ),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "FeedbackLimitError" ||
          error._tag === "FeedbackOffError" ||
          error._tag === "FeedbackNotRequestedError" ||
          error._tag === "FeedbackAnsweredError"
            ? error
            : storageError(error),
        ),
      );
    const sent = yield* analytics.record("agent.feedback", {
      ...preview,
      userRequested,
      source: context.source,
      ...context.dimensions,
    });
    if (sent) {
      yield* sql`UPDATE agent_feedback SET sent = 1 WHERE id = ${report.id}`.pipe(
        Effect.mapError(storageError),
      );
    }
    return { ...report, sent };
  });

  const store: FeedbackStore["Service"]["store"] = ({ preview, ...context }) =>
    save(preview, { ...context, userRequested: false }).pipe(
      // Only a card's report can find itself already answered.
      Effect.catchTags({ FeedbackAnsweredError: Effect.die }),
      Effect.withSpan("FeedbackStore.store"),
    );

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
    const recordFailed = (cause: unknown) =>
      new AgentFeedbackRequestError({ reason: "record_failed", cause });

    if (input.answer === "decline") {
      // The card keeps only what would have been sent without the conversation.
      return yield* lock
        .withPermit(
          Effect.gen(function* () {
            if (!(yield* stillWaiting(card.reportId).pipe(Effect.mapError(storageError)))) {
              return yield* fail("already_answered");
            }
            yield* record({ ...card, preview: item.preview }, "declined");
          }),
        )
        .pipe(
          Effect.catchTags({ FeedbackStorageError: (error) => Effect.fail(recordFailed(error)) }),
        );
    }

    const preview: AgentFeedbackPreview = {
      ...item.preview,
      trace:
        input.includeConversation === true && item.conversationTrace !== undefined
          ? item.conversationTrace
          : item.preview.trace,
    };
    const { runs } = yield* threads
      .getThreadRecords(input.threadId, ["runs"], { runIds: [card.runId] })
      .pipe(
        Effect.mapError((cause) => new AgentFeedbackRequestError({ reason: "load_failed", cause })),
      );
    const run = runs.find((candidate) => candidate.id === card.runId);
    const providerList = yield* providers.getProviders;
    yield* save(preview, {
      id: card.reportId,
      source: "mcp",
      threadId: input.threadId,
      runId: card.runId,
      dimensions: run === undefined ? {} : providerDimensions(providerList, run.modelSelection),
      userRequested: true,
    }).pipe(
      // Telemetry off stores the report without sending it, so the card says not sent.
      Effect.flatMap((report) =>
        record({ ...card, preview }, report.sent ? "sent" : "cancelled").pipe(Effect.ignore),
      ),
      Effect.catchTags({
        FeedbackAnsweredError: () => fail("already_answered"),
        FeedbackOffError: () =>
          record({ ...card, preview: item.preview }, "cancelled").pipe(
            Effect.ignore,
            Effect.andThen(fail("feedback_off")),
          ),
        // A requested report is never over a limit or refused by When I ask.
        FeedbackLimitError: Effect.die,
        FeedbackNotRequestedError: Effect.die,
        // The card stays open, so Send can be tried again.
        FeedbackStorageError: (error) => Effect.fail(recordFailed(error)),
      }),
    );
  });

  return FeedbackStore.of({ store, showCard, answer });
});

export const layer = Layer.effect(FeedbackStore, make);

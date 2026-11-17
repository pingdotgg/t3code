import * as NodeOS from "node:os";

import {
  type AgentFeedbackPreview,
  CommandId,
  OrchestrationV2RunStatus,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Analytics from "../telemetry/AnalyticsService.ts";
import { providerDimensions } from "../telemetry/ProviderDimensions.ts";
import {
  FEEDBACK_NOT_APPROVED_NOTE,
  FeedbackOffError,
  FeedbackStorageError,
  FEEDBACK_SUBJECT_MESSAGE,
  FEEDBACK_TRACE_TURNS,
  type FeedbackInput,
  type FeedbackNotApproved,
  type FeedbackReport,
  FeedbackTrace,
  resolveFeedbackSubject,
} from "./FeedbackReport.ts";
import * as Approvals from "./FeedbackApprovals.ts";
import { buildFeedbackTrace, FEEDBACK_TRACE_ITEM_TYPES } from "./FeedbackTrace.ts";
import { scrubFeedback } from "./scrubFeedback.ts";

// Requested and unprompted reports count apart, so neither can use up the other's turn.
const MAX_REPORTS_PER_TURN = 3;
// Reports from no turn, such as `t3 feedback`, have no turn to count in.
const MAX_REPORTS_OUTSIDE_TURNS_PER_HOUR = 10;
// As long as a secret card waits; Claude's and Codex's T3 tool calls allow 65 minutes.
const APPROVAL_TIMEOUT = Duration.minutes(10);

export class FeedbackLimitError extends Schema.TaggedError<FeedbackLimitError>()(
  "FeedbackLimitError",
  { scope: Schema.Literals(["turn", "hour"]) },
) {
  override get message() {
    return this.scope === "turn"
      ? `This turn already sent ${MAX_REPORTS_PER_TURN} agent feedback reports of this kind; nothing was sent.`
      : `This machine already sent ${MAX_REPORTS_OUTSIDE_TURNS_PER_HOUR} agent feedback reports outside a turn in the last hour; nothing was sent.`;
  }
}

export class FeedbackSubjectError extends Schema.TaggedError<FeedbackSubjectError>()(
  "FeedbackSubjectError",
  {},
) {
  override get message() {
    return FEEDBACK_SUBJECT_MESSAGE;
  }
}

export class FeedbackNotRequestedError extends Schema.TaggedError<FeedbackNotRequestedError>()(
  "FeedbackNotRequestedError",
  { source: Schema.Literals(["mcp", "cli"]) },
) {
  override get message() {
    return this.source === "cli"
      ? "Agent feedback is set to When I ask: ask your agent in a thread to send it, so you can approve what is sent."
      : "Agent feedback is set to When I ask: send a report only when the user asks for one.";
  }
}

export class FeedbackTurnsError extends Schema.TaggedError<FeedbackTurnsError>()(
  "FeedbackTurnsError",
  {},
) {
  override get message() {
    return "Conversation text goes only on a report the user asked for (userRequested).";
  }
}

/** The approved card's turn ended, or its card closed, before the report was stored. */
class FeedbackTurnEndedError extends Schema.TaggedError<FeedbackTurnEndedError>()(
  "FeedbackTurnEndedError",
  {},
) {}

/** A requested report needs a thread with an active turn to show the user its preview. */
export class FeedbackApprovalError extends Schema.TaggedError<FeedbackApprovalError>()(
  "FeedbackApprovalError",
  {},
) {
  override get message() {
    return "A report the user asks for is shown to them for approval in their thread, and this call has no active thread turn, so nothing was sent.";
  }
}

export interface FeedbackCaller {
  readonly source: "mcp" | "cli";
  readonly threadId?: ThreadId;
}

export class FeedbackService extends Context.Service<
  FeedbackService,
  {
    /**
     * Sends an unprompted report at once. A requested one is shown to the user first and is
     * stored and sent only if they approve, exactly as shown.
     */
    readonly submit: (
      input: FeedbackInput,
      caller: FeedbackCaller,
    ) => Effect.Effect<
      FeedbackReport | FeedbackNotApproved,
      | FeedbackOffError
      | FeedbackNotRequestedError
      | FeedbackTurnsError
      | FeedbackSubjectError
      | FeedbackApprovalError
      | FeedbackLimitError
      | FeedbackStorageError
    >;
  }
>()("t3/feedback/FeedbackService") {}

const storageError = (cause: unknown) => new FeedbackStorageError({ cause });
const isRunStatus = Schema.is(OrchestrationV2RunStatus);
const TraceJson = Schema.NullOr(Schema.fromJsonString(FeedbackTrace));
const encodeTrace = Schema.encodeEffect(TraceJson);

/** `mcpToolNames` is read per report: the MCP server registers tools after this service starts. */
const make = Effect.fn("FeedbackService.make")(function* (
  mcpToolNames: () => ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectService;
  const providers = yield* Providers.ProviderRegistry;
  const settings = yield* Settings.ServerSettingsService;
  const analytics = yield* Analytics.AnalyticsService;
  const random = yield* SecureRandom.SecureRandom;
  const approvals = yield* Approvals.FeedbackApprovals;
  // Serializes the limit check with its insert.
  const lock = yield* Semaphore.make(1);
  const requireOn = settings.getSettings.pipe(
    Effect.mapError(storageError),
    Effect.flatMap(({ agentFeedback: { mode } }) =>
      mode === "off" ? Effect.fail(new FeedbackOffError({})) : Effect.succeed(mode),
    ),
  );

  const submit = Effect.fn("FeedbackService.submit")(function* (
    input: FeedbackInput,
    caller: FeedbackCaller,
  ) {
    const mode = yield* requireOn;
    if (mode === "on-request" && !input.userRequested) {
      return yield* new FeedbackNotRequestedError({ source: caller.source });
    }
    if (input.includeTurns > 0 && !input.userRequested) {
      return yield* new FeedbackTurnsError({});
    }
    const subject = resolveFeedbackSubject(input.subject, mcpToolNames());
    if (subject === undefined) return yield* new FeedbackSubjectError({});
    if (input.userRequested && caller.threadId === undefined) {
      return yield* new FeedbackApprovalError({});
    }

    const thread =
      caller.threadId === undefined
        ? undefined
        : ((yield* threads.getThreadShell(caller.threadId).pipe(Effect.mapError(storageError))) ??
          undefined);
    const project =
      thread === undefined
        ? undefined
        : Option.getOrUndefined(
            yield* projects.getById(thread.projectId).pipe(Effect.mapError(storageError)),
          );
    const repository = project?.repositoryIdentity ?? undefined;
    const sensitive = [
      caller.threadId ?? "",
      thread?.projectId ?? "",
      NodeOS.homedir(),
      NodeOS.userInfo().username,
      NodeOS.hostname(),
      thread?.worktreePath ?? "",
      thread?.branch ?? "",
      project?.workspaceRoot ?? "",
      project?.title ?? "",
      repository?.locator.remoteUrl ?? "",
      repository?.origin?.remoteUrl ?? "",
      repository?.webUrl ?? "",
      repository?.canonicalKey ?? "",
      repository?.owner !== undefined && repository.name !== undefined
        ? `${repository.owner}/${repository.name}`
        : "",
    ];
    const providerList = yield* providers.getProviders;
    const dimensions =
      caller.source === "mcp" && thread !== undefined
        ? providerDimensions(providerList, thread.modelSelection)
        : {};
    // Only a report the user asked for carries a trace, and only from its own thread.
    const trace =
      input.userRequested && caller.threadId !== undefined
        ? yield* Effect.gen(function* () {
            const threadId = caller.threadId!;
            // Records cannot filter on started, so widen past the unstarted (queued) runs the
            // last read found. Each pass reads more runs than the one before, until it holds
            // enough started runs or the whole thread.
            let limit = FEEDBACK_TRACE_TURNS;
            let runs = (yield* threads.getThreadRecords(threadId, ["runs"], {
              latestRunLimit: limit,
            })).runs;
            while (runs.length === limit) {
              const unstarted = runs.filter((run) => run.startedAt === null).length;
              if (runs.length - unstarted >= FEEDBACK_TRACE_TURNS) break;
              limit = FEEDBACK_TRACE_TURNS + unstarted;
              runs = (yield* threads.getThreadRecords(threadId, ["runs"], {
                latestRunLimit: limit,
              })).runs;
            }
            const { turnItems } = yield* threads.getThreadRecords(threadId, ["turnItems"], {
              turnItemRunIds: runs.map((run) => run.id),
              turnItemTypes: FEEDBACK_TRACE_ITEM_TYPES,
            });
            return buildFeedbackTrace({
              runs,
              items: turnItems,
              includeTurns: input.includeTurns,
              sensitive,
              t3Tools: mcpToolNames(),
              driverOf: (run) =>
                providerList.find((provider) => provider.instanceId === run.providerInstanceId)
                  ?.driver,
            });
          }).pipe(Effect.mapError(storageError))
        : null;
    const preview: AgentFeedbackPreview = {
      kind: input.kind,
      subject,
      expected: scrubFeedback(input.expected, sensitive),
      actual: scrubFeedback(input.actual, sensitive),
      workaround: scrubFeedback(input.workaround, sensitive),
      trace,
    };
    const runId = thread?.activeRunId ?? null;
    const id = yield* random.uuidV7();
    if (!input.userRequested) {
      return yield* store(preview, { caller, runId, id, dimensions, userRequested: false }).pipe(
        // Only an approved card's turn can end under a report.
        Effect.catchTags({ FeedbackTurnEndedError: Effect.die }),
      );
    }

    // Nothing is stored, sent or counted before the user answers.
    const limited = yield* overLimit(runId, true);
    if (limited !== undefined) return yield* new FeedbackLimitError({ scope: limited });
    const run =
      runId === null || caller.threadId === undefined
        ? undefined
        : (yield* threads
            .getThreadRecords(caller.threadId, ["runs"], { runIds: [runId] })
            .pipe(Effect.mapError(storageError))).runs.find((candidate) => candidate.id === runId);
    if (caller.threadId === undefined || run === undefined || run.rootNodeId === null) {
      return yield* new FeedbackApprovalError({});
    }
    const card = {
      threadId: caller.threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      turnItemId: TurnItemId.make(`turn-item:feedback-request:${id}`),
      preview,
    };
    const record = (feedbackStatus: "pending" | "sent" | "declined" | "cancelled") =>
      threads
        .dispatch({
          type: "feedback_request.record",
          commandId: CommandId.make(`feedback-request:${id}:${feedbackStatus}`),
          ...card,
          feedbackStatus,
        })
        .pipe(Effect.mapError(storageError));
    const answered = yield* approvals.open(card).pipe(
      Effect.tap(() => record("pending")),
      Effect.flatMap(Deferred.await),
      Effect.timeoutOption(APPROVAL_TIMEOUT),
      // An aborted call, a failed record or a timeout closes the card unsent.
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) && Option.isSome(exit.value)
          ? Effect.void
          : record("cancelled").pipe(Effect.ignore),
      ),
      Effect.scoped,
    );
    if (Option.isNone(answered) || answered.value === "decline") {
      const status = Option.isNone(answered) ? "timed_out" : "declined";
      if (status === "declined") yield* record("declined").pipe(Effect.ignore);
      return { approved: false, status, note: FEEDBACK_NOT_APPROVED_NOTE[status] } as const;
    }
    // The answer can come long after the call: Off or a stopped turn since then sends nothing.
    return yield* store(preview, {
      caller,
      runId,
      id,
      dimensions,
      userRequested: true,
      card: { runId: card.runId, turnItemId: card.turnItemId },
    }).pipe(
      Effect.tap(() => record("sent").pipe(Effect.ignore)),
      Effect.tapError(() => record("cancelled").pipe(Effect.ignore)),
      Effect.catchTags({
        FeedbackTurnEndedError: () =>
          Effect.succeed({
            approved: false,
            status: "cancelled",
            note: FEEDBACK_NOT_APPROVED_NOTE.cancelled,
          } as const),
      }),
    );
  });

  /** Stores and sends a report as built, with `userRequested` only for an approved preview. */
  const store = Effect.fn("FeedbackService.store")(function* (
    preview: AgentFeedbackPreview,
    context: {
      readonly caller: FeedbackCaller;
      readonly runId: string | null;
      readonly id: string;
      readonly dimensions: Readonly<Record<string, string>>;
      /** True only for a preview the user approved. */
      readonly userRequested: boolean;
      /** The approved card, whose turn must still be live and card still waiting. */
      readonly card?: { readonly runId: string; readonly turnItemId: string };
    },
  ) {
    const { userRequested } = context;
    const properties = {
      ...preview,
      userRequested,
      source: context.caller.source,
      ...context.dimensions,
    };
    const report = {
      ...preview,
      userRequested,
      source: context.caller.source,
      id: context.id,
      threadId: context.caller.threadId ?? null,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    const traceJson = yield* encodeTrace(preview.trace).pipe(Effect.mapError(storageError));
    yield* lock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const limited = yield* overLimit(context.runId, userRequested);
            if (limited !== undefined) return yield* new FeedbackLimitError({ scope: limited });
            // The projection shares this database and writer, so a stop that commits first is
            // seen here and none can commit between this read and the insert.
            if (context.card !== undefined) {
              const [live] = yield* sql<{
                readonly runStatus: string;
                readonly cardStatus: string | null;
              }>`
                SELECT run.status AS "runStatus", card.status AS "cardStatus"
                FROM orchestration_v2_projection_runs run
                LEFT JOIN orchestration_v2_projection_turn_items card
                  ON card.turn_item_id = ${context.card.turnItemId}
                WHERE run.run_id = ${context.card.runId}`;
              if (
                live === undefined ||
                live.cardStatus !== "waiting" ||
                !isRunStatus(live.runStatus) ||
                Threads.isTerminalRunStatus(live.runStatus)
              ) {
                return yield* new FeedbackTurnEndedError({});
              }
            }
            // Last before the insert: the setting can turn Off while a requested report waits.
            yield* requireOn;
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
              user_requested: report.userRequested ? 1 : 0,
              trace: traceJson,
              source: report.source,
              sent: 0,
            })}`;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "FeedbackLimitError" ||
            error._tag === "FeedbackOffError" ||
            error._tag === "FeedbackTurnEndedError"
              ? error
              : storageError(error),
          ),
        ),
    );
    const sent = yield* analytics.record("agent.feedback", properties);
    if (sent) {
      yield* sql`UPDATE agent_feedback SET sent = 1 WHERE id = ${report.id}`.pipe(
        Effect.mapError(storageError),
      );
    }
    return { ...report, sent };
  });

  /** The limit the next report would pass, or undefined while there is room. */
  const overLimit = Effect.fn("FeedbackService.overLimit")(function* (
    runId: string | null,
    userRequested: boolean,
  ) {
    if (runId !== null) {
      const [row] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM agent_feedback
        WHERE run_id = ${runId} AND user_requested = ${userRequested ? 1 : 0}`.pipe(
        Effect.mapError(storageError),
      );
      return (row?.count ?? 0) >= MAX_REPORTS_PER_TURN ? ("turn" as const) : undefined;
    }
    const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 1 }));
    const [row] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM agent_feedback
      WHERE run_id IS NULL AND created_at > ${since}`.pipe(Effect.mapError(storageError));
    return (row?.count ?? 0) >= MAX_REPORTS_OUTSIDE_TURNS_PER_HOUR ? ("hour" as const) : undefined;
  });

  return FeedbackService.of({ submit });
});

export const layer = (mcpToolNames: () => ReadonlyArray<string>) =>
  Layer.effect(FeedbackService, make(mcpToolNames));

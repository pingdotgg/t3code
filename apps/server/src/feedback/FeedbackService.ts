import * as NodeOS from "node:os";

import {
  type AgentFeedbackPreview,
  CommandId,
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
  FEEDBACK_OFF_MESSAGE,
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

const MAX_REPORTS_PER_RUN = 3;
const MAX_REPORTS_PER_THREAD = 10;
const LIST_LIMIT = 50;
// As long as a secret card waits; Claude's and Codex's T3 tool calls allow 65 minutes.
const APPROVAL_TIMEOUT = Duration.minutes(10);

export class FeedbackOffError extends Schema.TaggedError<FeedbackOffError>()(
  "FeedbackOffError",
  {},
) {
  override get message() {
    return FEEDBACK_OFF_MESSAGE;
  }
}

export class FeedbackLimitError extends Schema.TaggedError<FeedbackLimitError>()(
  "FeedbackLimitError",
  {},
) {
  override get message() {
    return `This thread already sent the most agent feedback reports allowed (${MAX_REPORTS_PER_RUN} per turn, ${MAX_REPORTS_PER_THREAD} per thread).`;
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

/** A requested report needs a thread with an active turn to show the user its preview. */
export class FeedbackApprovalError extends Schema.TaggedError<FeedbackApprovalError>()(
  "FeedbackApprovalError",
  {},
) {
  override get message() {
    return "A report the user asks for is shown to them for approval in their thread, and this call has no active thread turn, so nothing was sent.";
  }
}

export class FeedbackStorageError extends Schema.TaggedError<FeedbackStorageError>()(
  "FeedbackStorageError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not save agent feedback.";
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
    /** Newest first. */
    readonly list: Effect.Effect<
      ReadonlyArray<FeedbackReport>,
      FeedbackOffError | FeedbackStorageError
    >;
  }
>()("t3/feedback/FeedbackService") {}

const storageError = (cause: unknown) => new FeedbackStorageError({ cause });
const TraceJson = Schema.NullOr(Schema.fromJsonString(FeedbackTrace));
const decodeTrace = Schema.decodeUnknownEffect(TraceJson);
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
      return yield* store(preview, { caller, runId, id, dimensions, userRequested: false });
    }

    // Nothing is stored, sent or counted before the user answers.
    if (yield* overLimit(caller.threadId ?? null, runId)) return yield* new FeedbackLimitError({});
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
    return yield* store(preview, { caller, runId, id, dimensions, userRequested: true }).pipe(
      Effect.tap(() => record("sent").pipe(Effect.ignore)),
      Effect.tapError(() => record("cancelled").pipe(Effect.ignore)),
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
            if (yield* overLimit(report.threadId, context.runId)) {
              return yield* new FeedbackLimitError({});
            }
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
            error._tag === "FeedbackLimitError" ? error : storageError(error),
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

  const overLimit = (threadId: string | null, runId: string | null) =>
    threadId === null
      ? Effect.succeed(false)
      : sql<{ readonly thread: number; readonly run: number }>`
          SELECT COUNT(*) AS thread, COALESCE(SUM(run_id IS ${runId}), 0) AS run
          FROM agent_feedback WHERE thread_id = ${threadId}`.pipe(
          Effect.map(
            ([counts]) =>
              (counts?.thread ?? 0) >= MAX_REPORTS_PER_THREAD ||
              (counts?.run ?? 0) >= MAX_REPORTS_PER_RUN,
          ),
          Effect.mapError(storageError),
        );

  const list = requireOn.pipe(
    Effect.andThen(
      () =>
        sql<
          Omit<FeedbackReport, "sent" | "userRequested" | "trace"> & {
            readonly sent: number;
            readonly userRequested: number;
            readonly trace: string | null;
          }
        >`
      SELECT id, thread_id AS "threadId", created_at AS "createdAt", kind, subject,
        expected, actual, workaround, user_requested AS "userRequested", trace, source, sent
      FROM agent_feedback ORDER BY rowid DESC LIMIT ${LIST_LIMIT}`,
    ),
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        decodeTrace(row.trace).pipe(
          Effect.map((trace) => ({
            ...row,
            trace,
            userRequested: row.userRequested === 1,
            sent: row.sent === 1,
          })),
        ),
      ),
    ),
    Effect.mapError((error) => (error._tag === "FeedbackOffError" ? error : storageError(error))),
  );

  return FeedbackService.of({ submit, list });
});

export const layer = (mcpToolNames: () => ReadonlyArray<string>) =>
  Layer.effect(FeedbackService, make(mcpToolNames));

import * as NodeOS from "node:os";

import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
import { type FeedbackInput, type FeedbackReport, T3_CLI_COMMANDS } from "./FeedbackReport.ts";
import { scrubFeedback } from "./scrubFeedback.ts";

const MAX_REPORTS_PER_RUN = 3;
const MAX_REPORTS_PER_THREAD = 10;
const LIST_LIMIT = 50;

export class FeedbackOffError extends Schema.TaggedError<FeedbackOffError>()(
  "FeedbackOffError",
  {},
) {
  override get message() {
    return "Agent feedback is off. The user can turn it on in Settings. Turn it on with t3_environment_preferences_update (agentFeedback: { enabled: true }) only when the user asked you to send feedback.";
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
    readonly submit: (
      input: FeedbackInput,
      caller: FeedbackCaller,
    ) => Effect.Effect<
      FeedbackReport,
      FeedbackOffError | FeedbackLimitError | FeedbackStorageError
    >;
    /** Newest first. */
    readonly list: Effect.Effect<ReadonlyArray<FeedbackReport>, FeedbackStorageError>;
  }
>()("t3/feedback/FeedbackService") {}

const storageError = (cause: unknown) => new FeedbackStorageError({ cause });

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
  // Serializes the limit check with its insert.
  const lock = yield* Semaphore.make(1);

  const submit = Effect.fn("FeedbackService.submit")(function* (
    input: FeedbackInput,
    caller: FeedbackCaller,
  ) {
    const current = yield* settings.getSettings.pipe(Effect.mapError(storageError));
    if (!current.agentFeedback.enabled) return yield* new FeedbackOffError({});

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
    const subjects = new Set([...mcpToolNames(), ...T3_CLI_COMMANDS]);
    const dimensions =
      caller.source === "mcp" && thread !== undefined
        ? providerDimensions(yield* providers.getProviders, thread.modelSelection)
        : {};
    const properties = {
      kind: input.kind,
      subject: subjects.has(input.subject.trim()) ? input.subject.trim() : "",
      expected: scrubFeedback(input.expected, sensitive),
      actual: scrubFeedback(input.actual, sensitive),
      workaround: scrubFeedback(input.workaround, sensitive),
      source: caller.source,
      ...dimensions,
    };
    const report = {
      kind: properties.kind,
      subject: properties.subject,
      expected: properties.expected,
      actual: properties.actual,
      workaround: properties.workaround,
      source: properties.source,
      id: yield* random.uuidV7(),
      threadId: caller.threadId ?? null,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    const runId = thread?.activeRunId ?? null;

    yield* lock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (report.threadId !== null) {
              const [counts] = yield* sql<{ readonly thread: number; readonly run: number }>`
                SELECT COUNT(*) AS thread, COALESCE(SUM(run_id IS ${runId}), 0) AS run
                FROM agent_feedback WHERE thread_id = ${report.threadId}`;
              if (
                (counts?.thread ?? 0) >= MAX_REPORTS_PER_THREAD ||
                (counts?.run ?? 0) >= MAX_REPORTS_PER_RUN
              ) {
                return yield* new FeedbackLimitError({});
              }
            }
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

  const list = Effect.suspend(
    () => sql<Omit<FeedbackReport, "sent"> & { readonly sent: number }>`
      SELECT id, thread_id AS "threadId", created_at AS "createdAt", kind, subject,
        expected, actual, workaround, source, sent
      FROM agent_feedback ORDER BY rowid DESC LIMIT ${LIST_LIMIT}`,
  ).pipe(
    Effect.map((rows) => rows.map((row) => ({ ...row, sent: row.sent === 1 }))),
    Effect.mapError(storageError),
  );

  return FeedbackService.of({ submit, list });
});

export const layer = (mcpToolNames: () => ReadonlyArray<string>) =>
  Layer.effect(FeedbackService, make(mcpToolNames));

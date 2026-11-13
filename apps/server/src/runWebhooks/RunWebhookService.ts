// @effect-diagnostics-next-line nodeBuiltinImport:off -- Stable registration IDs use SHA-256.
import * as NodeCrypto from "node:crypto";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  RunId,
  ThreadId,
  RunWebhookPayload,
  RunWebhookResult,
  type RunWebhookInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Transport from "./RunWebhookTransport.ts";

export class RunWebhookError extends Schema.TaggedError<RunWebhookError>()("RunWebhookError", {
  reason: Schema.Literals(["forbidden", "not_found", "limit", "storage", "thread"]),
}) {
  override get message() {
    switch (this.reason) {
      case "forbidden":
        return "Run webhooks require a live outside client and a destination configured for that client.";
      case "not_found":
        return "The run webhook subscription or run was not found.";
      case "limit":
        return "The run webhook subscription limit has been reached.";
      case "storage":
        return "Run webhook storage is unavailable.";
      case "thread":
        return "Run webhook thread state is unavailable.";
    }
  }
}

const Row = Schema.Struct({
  id: Schema.String,
  session_id: Schema.String,
  endpoint_id: Schema.String,
  endpoint_fingerprint: Schema.String,
  thread_id: ThreadId,
  run_id: RunId,
  link: Schema.String,
  state: RunWebhookResult.fields.state,
  last_observation: Schema.NullOr(Schema.String),
  payload: Schema.NullOr(Schema.String),
  attempts: Schema.Number,
  next_attempt_at: Schema.Number,
  expires_at: Schema.Number,
});
type Row = typeof Row.Type;
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const validatePayload = Schema.decodeUnknownEffect(RunWebhookPayload);
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(RunWebhookPayload));
const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(RunWebhookPayload));
const LIFETIME = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 12;
const terminal = (status: string) =>
  ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
const result = (row: Row): RunWebhookResult => ({
  subscriptionId: row.id,
  threadId: row.thread_id,
  runId: row.run_id,
  state: row.state,
  attempts: row.attempts,
  expiresAt: DateTime.formatIso(DateTime.makeUnsafe(row.expires_at)),
});

export class RunWebhookService extends Context.Service<
  RunWebhookService,
  {
    readonly manage: (
      sessionId: string,
      input: RunWebhookInput,
      link?: string,
    ) => Effect.Effect<RunWebhookResult, RunWebhookError>;
    readonly runDueWork: Effect.Effect<void, RunWebhookError>;
  }
>()("t3/runWebhooks/RunWebhookService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const { endpoints } = yield* Transport.RunWebhookEndpoints;
  const transport = yield* Transport.RunWebhookTransport;
  const lock = yield* Semaphore.make(1);
  const workerLock = yield* Semaphore.make(1);

  const authorized = Effect.fn("RunWebhookService.authorized")(function* (sessionId: string) {
    const found = yield* sessions
      .getById({ sessionId: AuthSessionId.make(sessionId) })
      .pipe(Effect.mapError(() => new RunWebhookError({ reason: "storage" })));
    const now = yield* Clock.currentTimeMillis;
    return (
      Option.isSome(found) &&
      found.value.revokedAt === null &&
      DateTime.toEpochMillis(found.value.expiresAt) > now &&
      found.value.scopes.includes(AuthOrchestrationReadScope) &&
      found.value.scopes.includes(AuthOrchestrationOperateScope)
    );
  });
  const load = Effect.fn("RunWebhookService.load")(function* (id: string, sessionId: string) {
    const rows =
      yield* sql`SELECT * FROM run_webhook_subscriptions WHERE id = ${id} AND session_id = ${sessionId}`.pipe(
        Effect.flatMap(decodeRows),
        Effect.mapError(() => new RunWebhookError({ reason: "storage" })),
      );
    if (!rows[0]) return yield* new RunWebhookError({ reason: "not_found" });
    return rows[0];
  });
  const manage: RunWebhookService["Service"]["manage"] = Effect.fn("RunWebhookService.manage")(
    function* (sessionId, input, link) {
      if (!(yield* authorized(sessionId)))
        return yield* new RunWebhookError({ reason: "forbidden" });
      const now = yield* Clock.currentTimeMillis;
      if (input.action !== "subscribe") {
        const row = yield* load(input.subscriptionId, sessionId);
        if (input.action === "cancel") {
          yield* sql`UPDATE run_webhook_subscriptions SET state = 'cancelled', payload = NULL
          WHERE id = ${row.id} AND state IN ('active', 'failed')`;
        } else if (input.action === "retry" && row.state === "failed" && row.expires_at > now) {
          yield* sql`UPDATE run_webhook_subscriptions SET state = 'active', attempts = 0, next_attempt_at = ${now}
          WHERE id = ${row.id}`;
        }
        return result(yield* load(row.id, sessionId));
      }
      const endpoint = endpoints.find(
        (entry) => entry.id === input.endpointId && entry.sessionId === sessionId,
      );
      if (!endpoint || link === undefined)
        return yield* new RunWebhookError({ reason: "forbidden" });
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(() => new RunWebhookError({ reason: "thread" })));
      if (!shell || shell.deletedAt !== null)
        return yield* new RunWebhookError({ reason: "not_found" });
      const records = yield* threads
        .getProjectThreadRecords(
          { threadId: input.threadId, projectId: shell.projectId },
          ["runs"],
          { runIds: [input.runId] },
        )
        .pipe(Effect.mapError(() => new RunWebhookError({ reason: "thread" })));
      if (!records.runs.some((run) => run.id === input.runId))
        return yield* new RunWebhookError({ reason: "not_found" });
      const id = NodeCrypto.createHash("sha256")
        .update(
          [sessionId, input.endpointId, input.threadId, input.runId]
            .map((value) => `${value.length}:${value}`)
            .join(""),
        )
        .digest("hex");
      const existing = yield* sql`SELECT * FROM run_webhook_subscriptions WHERE id = ${id}`.pipe(
        Effect.flatMap(decodeRows),
        Effect.mapError(() => new RunWebhookError({ reason: "storage" })),
      );
      const previous = existing[0];
      if (
        !previous ||
        previous.state === "cancelled" ||
        previous.state === "expired" ||
        previous.endpoint_fingerprint !== endpoint.fingerprint ||
        (previous.expires_at <= now && previous.state !== "delivered")
      ) {
        const [counts] = yield* sql<{ owned: number; active: number; total: number }>`SELECT
        COUNT(CASE WHEN session_id = ${sessionId} AND state = 'active' THEN 1 END) AS owned,
        COUNT(CASE WHEN state = 'active' THEN 1 END) AS active, COUNT(*) AS total
        FROM run_webhook_subscriptions`;
        if (
          !counts ||
          counts.owned - (previous?.state === "active" ? 1 : 0) >= 100 ||
          counts.active - (previous?.state === "active" ? 1 : 0) >= 1000 ||
          (!previous && counts.total >= 10000)
        )
          return yield* new RunWebhookError({ reason: "limit" });
        if (previous) {
          yield* sql`UPDATE run_webhook_subscriptions SET state = 'active', endpoint_fingerprint = ${endpoint.fingerprint},
            link = ${link}, payload = NULL, last_observation = NULL, attempts = 0,
            next_attempt_at = ${now}, expires_at = ${now + LIFETIME} WHERE id = ${id}`;
        } else
          yield* sql`INSERT INTO run_webhook_subscriptions
        (id, session_id, endpoint_id, endpoint_fingerprint, thread_id, run_id, link, state, next_attempt_at, expires_at)
        VALUES (${id}, ${sessionId}, ${endpoint.id}, ${endpoint.fingerprint}, ${input.threadId}, ${input.runId},
          ${link}, 'active', ${now}, ${now + LIFETIME})`;
      }
      return result(yield* load(id, sessionId));
    },
    lock.withPermits(1),
    Effect.catchTags({
      SqlError: () => Effect.fail(new RunWebhookError({ reason: "storage" })),
    }),
  );

  const prepare = Effect.fn("RunWebhookService.prepare")(function* (selected: Row) {
    const row = yield* load(selected.id, selected.session_id);
    if (row.state !== "active") return;
    const now = yield* Clock.currentTimeMillis;
    const endpoint = endpoints.find(
      (entry) =>
        entry.id === row.endpoint_id &&
        entry.sessionId === row.session_id &&
        entry.fingerprint === row.endpoint_fingerprint,
    );
    if (!endpoint || !(yield* authorized(row.session_id))) {
      yield* sql`UPDATE run_webhook_subscriptions SET state = 'cancelled', payload = NULL WHERE id = ${row.id} AND state = 'active'`;
      return;
    }
    const shell = yield* threads
      .getThreadShell(row.thread_id)
      .pipe(Effect.mapError(() => new RunWebhookError({ reason: "thread" })));
    if (!shell || shell.deletedAt !== null) {
      yield* sql`UPDATE run_webhook_subscriptions SET state = 'cancelled', payload = NULL WHERE id = ${row.id} AND state = 'active'`;
      return;
    }
    let body = row.payload;
    let attempts = row.attempts;
    const pending =
      body === null
        ? null
        : yield* decodePayload(body).pipe(
            Effect.mapError(() => new RunWebhookError({ reason: "storage" })),
          );
    if (pending === null || pending.status === "waiting") {
      const records = yield* threads
        .getProjectThreadRecords(
          { threadId: row.thread_id, projectId: shell.projectId },
          ["runs"],
          { runIds: [row.run_id] },
        )
        .pipe(Effect.mapError(() => new RunWebhookError({ reason: "thread" })));
      const run = records.runs.find((entry) => entry.id === row.run_id);
      if (!run) {
        yield* sql`UPDATE run_webhook_subscriptions SET state = 'cancelled' WHERE id = ${row.id} AND state = 'active'`;
        return;
      }
      const observation =
        run.status === "waiting" ? `waiting:${shell.pendingRuntimeRequest?.id ?? ""}` : run.status;
      if (
        (observation === row.last_observation && body === null) ||
        (!terminal(run.status) && run.status !== "waiting")
      ) {
        yield* sql`UPDATE run_webhook_subscriptions SET payload = NULL, last_observation = ${observation}, next_attempt_at = ${now + 5000}
          WHERE id = ${row.id} AND state = 'active'`;
        return;
      }
      if (observation !== row.last_observation) {
        const timeline = yield* threads
          .getTimelinePage(row.thread_id, {
            beforePosition: Number.POSITIVE_INFINITY,
            view: "messages",
            limit: 1,
          })
          .pipe(Effect.mapError(() => new RunWebhookError({ reason: "thread" })));
        const item = timeline.items[0]?.item;
        const message =
          item?.type === "assistant_message" || item?.type === "user_message" ? item : undefined;
        const payload = yield* validatePayload({
          version: 1,
          deliveryId: NodeCrypto.randomUUID(),
          subscriptionId: row.id,
          threadId: row.thread_id,
          runId: row.run_id,
          status: run.status,
          observedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          link: row.link,
          lastMessage:
            message === undefined
              ? null
              : {
                  id: message.messageId,
                  runId: message.runId,
                  role: message.type === "assistant_message" ? "assistant" : "user",
                  updatedAt: DateTime.formatIso(message.updatedAt),
                },
        }).pipe(Effect.mapError(() => new RunWebhookError({ reason: "thread" })));
        body = yield* encodePayload(payload).pipe(
          Effect.mapError(() => new RunWebhookError({ reason: "storage" })),
        );
        attempts = 0;
        yield* sql`UPDATE run_webhook_subscriptions SET payload = ${body}, attempts = 0, last_observation = ${observation}
        WHERE id = ${row.id} AND state = 'active'`;
      }
    }
    if (body === null || (body === row.payload && row.next_attempt_at > now)) return;
    const payload = yield* decodePayload(body).pipe(
      Effect.mapError(() => new RunWebhookError({ reason: "storage" })),
    );
    if (attempts >= MAX_ATTEMPTS) {
      yield* sql`UPDATE run_webhook_subscriptions SET state = ${terminal(payload.status) ? "failed" : "active"},
        next_attempt_at = ${now + 5000} WHERE id = ${row.id} AND state = 'active'`;
      return;
    }
    // Reserve the attempt before I/O, so a crash after sending cannot create a hot retry loop.
    yield* sql`UPDATE run_webhook_subscriptions SET attempts = ${attempts + 1},
      next_attempt_at = ${now + Math.min(3600000, 5000 * 2 ** attempts)} WHERE id = ${row.id} AND state = 'active'`;
    return { row, endpoint, body, payload, attempts, now };
  }, lock.withPermits(1));

  const process = Effect.fn("RunWebhookService.process")(function* (selected: Row) {
    const prepared = yield* prepare(selected);
    if (!prepared) return;
    const { row, endpoint, body, payload, attempts, now } = prepared;
    // Cancellation cannot recall an in-flight request, but it prevents subsequent attempts.
    const current = yield* load(row.id, row.session_id);
    if (current.state !== "active" || current.payload !== body) return;
    const sent = yield* transport
      .send(endpoint, body, Math.floor(now / 1000))
      .pipe(Effect.isSuccess);
    if (sent) {
      yield* sql`UPDATE run_webhook_subscriptions SET payload = NULL,
        state = ${terminal(payload.status) ? "delivered" : "active"}, next_attempt_at = ${now + 5000}
        WHERE id = ${row.id} AND state = 'active' AND payload = ${body}`;
    } else if (attempts + 1 >= MAX_ATTEMPTS && terminal(payload.status)) {
      yield* sql`UPDATE run_webhook_subscriptions SET state = 'failed'
        WHERE id = ${row.id} AND state = 'active' AND payload = ${body}`;
    }
  });

  const runDueWork = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`DELETE FROM run_webhook_subscriptions WHERE expires_at <= ${now - LIFETIME}`;
    yield* sql`UPDATE run_webhook_subscriptions SET state = 'expired', payload = NULL
      WHERE state IN ('active', 'failed') AND expires_at <= ${now}`;
    const rows = yield* sql`SELECT * FROM run_webhook_subscriptions
      WHERE state = 'active' AND (next_attempt_at <= ${now} OR json_extract(payload, '$.status') = 'waiting')
      ORDER BY ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY next_attempt_at, id), next_attempt_at, id LIMIT 4`.pipe(
      Effect.flatMap(decodeRows),
    );
    yield* Effect.forEach(
      rows,
      (row) =>
        process(row).pipe(
          Effect.catch(() =>
            sql`UPDATE run_webhook_subscriptions SET next_attempt_at = ${now + 60000}
        WHERE id = ${row.id} AND state = 'active'`.pipe(Effect.asVoid),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    workerLock.withPermits(1),
    Effect.mapError(() => new RunWebhookError({ reason: "storage" })),
  );
  return RunWebhookService.of({ manage, runDueWork });
});

export const layer = Layer.effect(RunWebhookService, make);
export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* RunWebhookService;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("run-webhooks", service.runDueWork);
  }),
);

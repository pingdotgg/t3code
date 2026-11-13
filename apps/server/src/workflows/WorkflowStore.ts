import {
  type WorkflowCounts,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStep,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export { WorkflowRun, WorkflowRunStatus, WorkflowStep };

/** Where a signal goes: one wait of one run, or whichever run of a workflow waits on a key. */
export type SignalAddress =
  | { readonly runId: string; readonly wait: string }
  | { readonly workflow: string; readonly key: string };

/** The run that invoked another, and the wait in it that hears how the other ended. */
export interface RunParent {
  readonly runId: string;
  readonly wait: string;
}

export interface RunRow {
  readonly run_id: string;
  readonly workflow: string;
  readonly version: number | bigint;
  readonly engine_tag: string;
  readonly title: string;
  readonly status: WorkflowRunStatus;
  readonly detail: string | null;
  readonly result_json: string | null;
  readonly input_json: string | null;
  readonly parent_run_id: string | null;
  readonly parent_wait: string | null;
  readonly pauses: number | bigint;
  readonly started_at: string;
  readonly updated_at: string;
  readonly ended_at: string | null;
}
export interface StepRow {
  readonly name: string;
  readonly kind: WorkflowStep["kind"];
  readonly status: WorkflowStep["status"];
  readonly attempts: number | bigint;
  readonly detail: string | null;
  readonly thread_id: string | null;
  readonly environment_id: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
}
export interface WaitRow {
  readonly run_id: string;
  readonly name: string;
  readonly token: string;
  readonly schema_json: string;
  readonly request_json: string | null;
  readonly deadline: string | null;
  readonly opened_at: string;
}

// Rows keep JSON as text. Everything stored was a JSON value when it was written.
export const jsonText = (value: Schema.Json): string => JSON.stringify(value);
export const jsonValue = (text: string): Schema.Json => JSON.parse(text) as Schema.Json;

const now = Effect.map(DateTime.now, DateTime.formatIso);
// Long enough for a sender's retries, short enough that the table stays small.
const SIGNAL_IDS_KEPT = Duration.days(7);
const mailAddress = (address: SignalAddress) =>
  "runId" in address
    ? `run:${address.runId}:${address.wait}`
    : `key:${address.workflow}:${address.key}`;

export class WorkflowStore extends Context.Service<
  WorkflowStore,
  {
    readonly changes: PubSub.PubSub<string>;
    readonly runStarted: (run: {
      readonly runId: string;
      readonly workflow: string;
      readonly version: number;
      readonly engineTag: string;
      readonly idempotencyKey: string;
      readonly input: Schema.Json;
      readonly parent?: RunParent | undefined;
    }) => Effect.Effect<void>;
    readonly runStatus: (
      runId: string,
      status: "running" | "waiting",
      detail: string | null,
    ) => Effect.Effect<void>;
    /**
     * A wait or an agent of the run is over. The run is running again, unless another it started
     * side by side is still out, which it then waits on.
     */
    readonly runResumed: (runId: string) => Effect.Effect<void>;
    readonly runPaused: (runId: string, detail: string) => Effect.Effect<void>;
    readonly runEnded: (
      runId: string,
      status: "completed" | "stopped" | "cancelled",
      detail: string | null,
      result: Schema.Json,
    ) => Effect.Effect<void>;
    readonly runTitle: (runId: string, title: string) => Effect.Effect<void>;
    /** Marks the step running and returns how many times it has now been started. */
    readonly stepStarted: (
      runId: string,
      name: string,
      kind: WorkflowStep["kind"],
    ) => Effect.Effect<number>;
    readonly stepEnded: (
      runId: string,
      name: string,
      status: "completed" | "failed",
      detail: string | null,
    ) => Effect.Effect<void>;
    readonly waitOpened: (wait: {
      readonly runId: string;
      readonly name: string;
      readonly workflow: string;
      readonly key: string | undefined;
      readonly token: string;
      readonly schemaJson: string;
      /** What a person is asked, when this wait is a question. */
      readonly requestJson: string | null;
      readonly deadline: string | null;
    }) => Effect.Effect<void>;
    readonly waitClosed: (runId: string, name: string) => Effect.Effect<void>;
    /** Takes the wait for one signal. False when another signal already has it. */
    readonly waitSignalled: (runId: string, name: string) => Effect.Effect<boolean>;
    readonly signalDelivered: (signalId: string) => Effect.Effect<void>;
    /** Whether a signal with this id already woke a wait. */
    readonly signalSeen: (signalId: string) => Effect.Effect<boolean>;
    /** Counts one more arrival at `name` in this run and returns the count. */
    readonly mark: (runId: string, name: string) => Effect.Effect<number>;
    /** The runs this one invoked that have not ended. */
    readonly children: (runId: string) => Effect.Effect<ReadonlyArray<RunRow>>;
    /** The steps a cancelled run left in flight are over: nothing will end them. */
    readonly stepsCancelled: (runId: string) => Effect.Effect<void>;
    /** Cancelled runs whose `onEnd` has not completed and may still be tried. */
    readonly runsToEnd: (step: string, tries: number) => Effect.Effect<ReadonlyArray<RunRow>>;
    readonly stepThread: (
      runId: string,
      name: string,
      threadId: string,
      environment: string | null,
    ) => Effect.Effect<void>;
    /** The threads of agent steps still running in this run. */
    readonly runningThreads: (
      runId: string,
    ) => Effect.Effect<ReadonlyArray<{ readonly threadId: string; readonly environment?: string }>>;
    readonly waitAt: (address: SignalAddress) => Effect.Effect<WaitRow | undefined>;
    readonly waitsPastDeadline: Effect.Effect<ReadonlyArray<WaitRow>>;
    readonly requests: Effect.Effect<ReadonlyArray<WaitRow>>;
    /** The thread of the run's latest agent step, if it has had one. */
    readonly latestThread: (
      runId: string,
    ) => Effect.Effect<{ readonly threadId: string; readonly environmentId: string | null } | null>;
    readonly counts: Effect.Effect<WorkflowCounts>;
    /** Say something about a step that is under way, such as when its sleep ends. */
    readonly stepDetail: (runId: string, name: string, detail: string) => Effect.Effect<void>;
    readonly mailPut: (mail: {
      readonly signalId: string;
      readonly address: SignalAddress;
      readonly valueJson: string;
      readonly expiresAt: string;
    }) => Effect.Effect<void>;
    /** The oldest signal kept for any of these addresses. It stays until `mailDelete`. */
    readonly mailNext: (
      addresses: ReadonlyArray<SignalAddress>,
    ) => Effect.Effect<{ readonly signalId: string; readonly valueJson: string } | undefined>;
    readonly mailDelete: (signalId: string) => Effect.Effect<void>;
    readonly mailExpire: Effect.Effect<void>;
    readonly run: (runId: string) => Effect.Effect<RunRow | undefined>;
    readonly runs: (status: WorkflowRunStatus | undefined) => Effect.Effect<ReadonlyArray<RunRow>>;
    readonly triggerNext: (triggerId: string) => Effect.Effect<string | undefined>;
    readonly triggerSet: (triggerId: string, nextAt: string) => Effect.Effect<void>;
    /** The hook's token: the one kept for it, or `fresh` from now on. */
    readonly hookToken: (hookId: string, fresh: string) => Effect.Effect<string>;
    readonly steps: (runId: string) => Effect.Effect<ReadonlyArray<StepRow>>;
  }
>()("t3/workflows/WorkflowStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<string>();
  // A write here is bookkeeping for a run the engine already journaled: failing it would park a
  // healthy run, so a database that cannot take it is a defect of the process instead.
  const write = <A, E>(runId: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.orDie, Effect.andThen(PubSub.publish(changes, runId)), Effect.asVoid);
  const waitColumns = sql`run_id, name, token, schema_json, request_json, deadline, opened_at`;

  return WorkflowStore.of({
    changes,
    runStarted: Effect.fn("WorkflowStore.runStarted")(function* (run) {
      const at = yield* now;
      yield* write(
        run.runId,
        sql`
          INSERT INTO workflow_runs (
            run_id, workflow, version, engine_tag, idempotency_key, title, status, input_json,
            parent_run_id, parent_wait, started_at, updated_at
          ) VALUES (
            ${run.runId}, ${run.workflow}, ${run.version}, ${run.engineTag},
            ${run.idempotencyKey}, ${`${run.workflow} ${run.idempotencyKey}`}, 'running',
            ${jsonText(run.input)}, ${run.parent?.runId ?? null}, ${run.parent?.wait ?? null},
            ${at}, ${at}
          )
          ON CONFLICT (run_id) DO NOTHING
        `,
      );
    }),
    runStatus: Effect.fn("WorkflowStore.runStatus")(function* (runId, status, detail) {
      const at = yield* now;
      yield* write(
        runId,
        sql`
          UPDATE workflow_runs
          SET status = ${status}, detail = ${detail}, updated_at = ${at}
          WHERE run_id = ${runId} AND ended_at IS NULL
        `,
      );
    }),
    runResumed: Effect.fn("WorkflowStore.runResumed")(function* (runId) {
      const at = yield* now;
      const out = yield* sql<{ name: string; kind: string }>`
        SELECT name, kind FROM workflow_steps
        WHERE run_id = ${runId} AND status = 'running' AND kind IN ('wait', 'ask', 'agent', 'sleep')
        ORDER BY started_at, rowid LIMIT 1
      `.pipe(Effect.orDie);
      const waiting = out[0];
      const detail =
        waiting === undefined
          ? null
          : waiting.kind === "agent" || waiting.kind === "sleep"
            ? `${waiting.kind} ${waiting.name}`
            : waiting.name;
      yield* write(
        runId,
        sql`
          UPDATE workflow_runs
          SET status = ${waiting === undefined ? "running" : "waiting"}, detail = ${detail},
              updated_at = ${at}
          WHERE run_id = ${runId} AND ended_at IS NULL
        `,
      );
    }),
    runPaused: Effect.fn("WorkflowStore.runPaused")(function* (runId, detail) {
      const at = yield* now;
      yield* write(
        runId,
        sql`
          UPDATE workflow_runs
          SET status = 'paused', detail = ${detail.slice(0, 2000)}, pauses = pauses + 1, updated_at = ${at}
          WHERE run_id = ${runId} AND ended_at IS NULL AND status != 'paused'
        `,
      );
    }),
    runEnded: Effect.fn("WorkflowStore.runEnded")(function* (runId, status, detail, result) {
      const at = yield* now;
      const resultJson = jsonText(result);
      yield* write(
        runId,
        sql.withTransaction(
          Effect.andThen(
            sql`
              UPDATE workflow_runs
              SET status = ${status}, detail = ${detail}, result_json = ${resultJson},
                  pauses = 0, updated_at = ${at}, ended_at = ${at}
              WHERE run_id = ${runId} AND ended_at IS NULL
            `,
            sql`DELETE FROM workflow_waits WHERE run_id = ${runId}`,
          ),
        ),
      );
    }),
    runTitle: Effect.fn("WorkflowStore.runTitle")(function* (runId, title) {
      yield* write(
        runId,
        sql`UPDATE workflow_runs SET title = ${title.slice(0, 200)} WHERE run_id = ${runId}`,
      );
    }),
    stepStarted: Effect.fn("WorkflowStore.stepStarted")(function* (runId, name, kind) {
      const at = yield* now;
      const rows = yield* sql<{ attempts: number | bigint }>`
        INSERT INTO workflow_steps (run_id, name, kind, status, attempts, started_at)
        VALUES (${runId}, ${name}, ${kind}, 'running', 1, ${at})
        ON CONFLICT (run_id, name) DO UPDATE
        SET status = 'running', attempts = attempts + 1, detail = NULL, ended_at = NULL,
            started_at = excluded.started_at
        RETURNING attempts
      `.pipe(Effect.orDie);
      yield* PubSub.publish(changes, runId);
      return Number(rows[0]?.attempts ?? 1);
    }),
    stepEnded: Effect.fn("WorkflowStore.stepEnded")(function* (runId, name, status, detail) {
      const at = yield* now;
      yield* write(
        runId,
        sql.withTransaction(
          Effect.andThen(
            sql`
              UPDATE workflow_steps
              SET status = ${status}, detail = ${detail === null ? null : detail.slice(0, 2000)}, ended_at = ${at}
              WHERE run_id = ${runId} AND name = ${name}
            `,
            // A step that finished is progress: the next pause is the first in a row again.
            status === "completed"
              ? sql`UPDATE workflow_runs SET pauses = 0 WHERE run_id = ${runId} AND ended_at IS NULL`
              : Effect.void,
          ),
        ),
      );
    }),
    waitOpened: Effect.fn("WorkflowStore.waitOpened")(function* (wait) {
      const at = yield* now;
      yield* write(
        wait.runId,
        sql`
          INSERT INTO workflow_waits (
            run_id, name, workflow, token, key, schema_json, request_json, deadline, opened_at
          ) VALUES (
            ${wait.runId}, ${wait.name}, ${wait.workflow}, ${wait.token}, ${wait.key ?? null},
            ${wait.schemaJson}, ${wait.requestJson}, ${wait.deadline}, ${at}
          )
          ON CONFLICT (run_id, name) DO NOTHING
        `,
      );
    }),
    waitClosed: Effect.fn("WorkflowStore.waitClosed")(function* (runId, name) {
      yield* write(
        runId,
        sql`DELETE FROM workflow_waits WHERE run_id = ${runId} AND name = ${name}`,
      );
    }),
    waitSignalled: Effect.fn("WorkflowStore.waitSignalled")(function* (runId, name) {
      const at = yield* now;
      const taken = yield* sql`
        UPDATE workflow_waits SET signalled_at = ${at}
        WHERE run_id = ${runId} AND name = ${name} AND signalled_at IS NULL
        RETURNING name
      `.pipe(Effect.orDie);
      return taken.length > 0;
    }),
    signalDelivered: Effect.fn("WorkflowStore.signalDelivered")(function* (signalId) {
      const at = yield* now;
      yield* sql`
        INSERT INTO workflow_signals (signal_id, delivered_at) VALUES (${signalId}, ${at})
        ON CONFLICT (signal_id) DO NOTHING
      `.pipe(Effect.orDie);
    }),
    signalSeen: Effect.fn("WorkflowStore.signalSeen")(function* (signalId) {
      const rows = yield* sql`
        SELECT 1 FROM workflow_signals WHERE signal_id = ${signalId}
      `.pipe(Effect.orDie);
      return rows.length > 0;
    }),
    mark: Effect.fn("WorkflowStore.mark")(function* (runId, name) {
      const rows = yield* sql<{ count: number | bigint }>`
        INSERT INTO workflow_marks (run_id, name, count) VALUES (${runId}, ${name}, 1)
        ON CONFLICT (run_id, name) DO UPDATE SET count = count + 1
        RETURNING count
      `.pipe(Effect.orDie);
      return Number(rows[0]?.count ?? 1);
    }),
    children: Effect.fn("WorkflowStore.children")(function* (runId) {
      return yield* sql<RunRow>`
        SELECT * FROM workflow_runs WHERE parent_run_id = ${runId} AND ended_at IS NULL
      `.pipe(Effect.orDie);
    }),
    stepsCancelled: Effect.fn("WorkflowStore.stepsCancelled")(function* (runId) {
      const at = yield* now;
      yield* write(
        runId,
        sql`
          UPDATE workflow_steps SET status = 'failed', detail = 'cancelled', ended_at = ${at}
          WHERE run_id = ${runId} AND status = 'running'
        `,
      );
    }),
    runsToEnd: Effect.fn("WorkflowStore.runsToEnd")(function* (step, tries) {
      // A day bounds the list: a cleanup that has not worked by then needs a person.
      const since = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, "1 day"));
      return yield* sql<RunRow>`
        SELECT r.* FROM workflow_runs r
        LEFT JOIN workflow_steps s ON s.run_id = r.run_id AND s.name = ${step}
        WHERE r.status = 'cancelled' AND r.ended_at > ${since}
          AND (s.status IS NULL OR (s.status != 'completed' AND s.attempts < ${tries}))
      `.pipe(Effect.orDie);
    }),
    stepThread: Effect.fn("WorkflowStore.stepThread")(
      function* (runId, name, threadId, environment) {
        yield* write(
          runId,
          sql`
          UPDATE workflow_steps SET thread_id = ${threadId}, environment_id = ${environment}
          WHERE run_id = ${runId} AND name = ${name}
        `,
        );
      },
    ),
    runningThreads: Effect.fn("WorkflowStore.runningThreads")(function* (runId) {
      const rows = yield* sql<{ thread_id: string; environment_id: string | null }>`
        SELECT thread_id, environment_id FROM workflow_steps
        WHERE run_id = ${runId} AND status = 'running' AND thread_id IS NOT NULL
      `.pipe(Effect.orDie);
      return rows.map((row) => ({
        threadId: row.thread_id,
        ...(row.environment_id === null ? {} : { environment: row.environment_id }),
      }));
    }),
    waitAt: Effect.fn("WorkflowStore.waitAt")(function* (address) {
      const rows = yield* (
        "runId" in address
          ? sql<WaitRow>`
              SELECT ${waitColumns} FROM workflow_waits
              WHERE run_id = ${address.runId} AND name = ${address.wait} AND signalled_at IS NULL
            `
          : sql<WaitRow>`
              SELECT ${waitColumns} FROM workflow_waits
              WHERE workflow = ${address.workflow} AND key = ${address.key} AND signalled_at IS NULL
              ORDER BY opened_at LIMIT 1
            `
      ).pipe(Effect.orDie);
      return rows[0];
    }),
    waitsPastDeadline: Effect.flatMap(now, (at) =>
      sql<WaitRow>`
        SELECT ${waitColumns} FROM workflow_waits
        WHERE deadline IS NOT NULL AND deadline <= ${at} AND signalled_at IS NULL
      `.pipe(Effect.orDie),
    ),
    latestThread: Effect.fn("WorkflowStore.latestThread")(function* (runId) {
      const rows = yield* sql<{ thread_id: string; environment_id: string | null }>`
        SELECT thread_id, environment_id FROM workflow_steps
        WHERE run_id = ${runId} AND thread_id IS NOT NULL
        ORDER BY started_at DESC, rowid DESC LIMIT 1
      `.pipe(Effect.orDie);
      const row = rows[0];
      return row === undefined
        ? null
        : { threadId: row.thread_id, environmentId: row.environment_id };
    }),
    counts: sql<{ questions: number; paused: number; active: number; total: number }>`
      SELECT
        (SELECT COUNT(*) FROM workflow_waits
          WHERE request_json IS NOT NULL AND signalled_at IS NULL) AS questions,
        (SELECT COUNT(*) FROM workflow_runs WHERE status = 'paused') AS paused,
        (SELECT COUNT(*) FROM workflow_runs WHERE ended_at IS NULL) AS active,
        (SELECT COUNT(*) FROM workflow_runs) AS total
    `.pipe(
      Effect.orDie,
      Effect.map((rows) => ({
        needsYou: Number(rows[0]?.questions ?? 0) + Number(rows[0]?.paused ?? 0),
        active: Number(rows[0]?.active ?? 0),
        total: Number(rows[0]?.total ?? 0),
      })),
    ),
    stepDetail: Effect.fn("WorkflowStore.stepDetail")(function* (runId, name, detail) {
      yield* write(
        runId,
        sql`UPDATE workflow_steps SET detail = ${detail} WHERE run_id = ${runId} AND name = ${name}`,
      );
    }),
    requests: sql<WaitRow>`
      SELECT ${waitColumns} FROM workflow_waits
      WHERE request_json IS NOT NULL AND signalled_at IS NULL ORDER BY opened_at
    `.pipe(Effect.orDie),
    mailPut: Effect.fn("WorkflowStore.mailPut")(function* (mail) {
      yield* sql`
        INSERT INTO workflow_mail (signal_id, address, value_json, expires_at)
        VALUES (${mail.signalId}, ${mailAddress(mail.address)}, ${mail.valueJson}, ${mail.expiresAt})
        ON CONFLICT (signal_id) DO NOTHING
      `.pipe(Effect.orDie);
    }),
    mailNext: Effect.fn("WorkflowStore.mailNext")(function* (addresses) {
      for (const address of addresses) {
        const rows = yield* sql<{ signal_id: string; value_json: string }>`
          SELECT signal_id, value_json FROM workflow_mail
          WHERE address = ${mailAddress(address)} ORDER BY rowid LIMIT 1
        `.pipe(Effect.orDie);
        const mail = rows[0];
        if (mail !== undefined) return { signalId: mail.signal_id, valueJson: mail.value_json };
      }
      return undefined;
    }),
    mailDelete: Effect.fn("WorkflowStore.mailDelete")(function* (signalId) {
      yield* sql`DELETE FROM workflow_mail WHERE signal_id = ${signalId}`.pipe(Effect.orDie);
    }),
    mailExpire: Effect.gen(function* () {
      const at = yield* DateTime.now;
      yield* sql`DELETE FROM workflow_mail WHERE expires_at <= ${DateTime.formatIso(at)}`;
      const kept = DateTime.formatIso(DateTime.subtractDuration(at, SIGNAL_IDS_KEPT));
      yield* sql`DELETE FROM workflow_signals WHERE delivered_at <= ${kept}`;
    }).pipe(Effect.orDie),
    run: Effect.fn("WorkflowStore.run")(function* (runId) {
      const rows = yield* sql<RunRow>`SELECT * FROM workflow_runs WHERE run_id = ${runId}`.pipe(
        Effect.orDie,
      );
      return rows[0];
    }),
    runs: Effect.fn("WorkflowStore.runs")(function* (status) {
      return yield* (
        status === undefined
          ? sql<RunRow>`SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT 500`
          : sql<RunRow>`
              SELECT * FROM workflow_runs WHERE status = ${status}
              ORDER BY started_at DESC LIMIT 500
            `
      ).pipe(Effect.orDie);
    }),
    triggerNext: Effect.fn("WorkflowStore.triggerNext")(function* (triggerId) {
      const rows = yield* sql<{ next_at: string }>`
        SELECT next_at FROM workflow_triggers WHERE trigger_id = ${triggerId}
      `.pipe(Effect.orDie);
      return rows[0]?.next_at;
    }),
    triggerSet: Effect.fn("WorkflowStore.triggerSet")(function* (triggerId, nextAt) {
      yield* sql`
        INSERT INTO workflow_triggers (trigger_id, next_at) VALUES (${triggerId}, ${nextAt})
        ON CONFLICT (trigger_id) DO UPDATE SET next_at = excluded.next_at
      `.pipe(Effect.orDie);
    }),
    hookToken: Effect.fn("WorkflowStore.hookToken")(function* (hookId, fresh) {
      yield* sql`
        INSERT INTO workflow_hooks (hook_id, token) VALUES (${hookId}, ${fresh})
        ON CONFLICT (hook_id) DO NOTHING
      `;
      const rows = yield* sql<{ token: string }>`
        SELECT token FROM workflow_hooks WHERE hook_id = ${hookId}
      `;
      return rows[0]?.token ?? fresh;
    }, Effect.orDie),
    steps: Effect.fn("WorkflowStore.steps")(function* (runId) {
      return yield* sql<StepRow>`
        SELECT name, kind, status, attempts, detail, thread_id, environment_id, started_at, ended_at
        FROM workflow_steps WHERE run_id = ${runId} ORDER BY started_at, rowid
      `.pipe(Effect.orDie);
    }),
  });
});

export const layer = Layer.effect(WorkflowStore, make);

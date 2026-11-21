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

/** Where a signal goes: one wait of one run, or whichever run of a workflow waits on a channel. */
export type SignalAddress =
  | { readonly runId: string; readonly wait: string }
  | { readonly workflow: string; readonly channel: string };

/** The run that invoked another, and the wait in it that hears how the other ended. */
export interface RunParent {
  readonly runId: string;
  readonly wait: string;
}

export interface RunRow {
  readonly run_id: string;
  readonly workflow: string;
  readonly idempotency_key: string;
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
  /** Paused until a person resumes it, whatever the workflow's `resumeAfter` says. */
  readonly held: number | bigint;
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
  readonly result_json: string | null;
  readonly said: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
}
export interface WaitRow {
  readonly run_id: string;
  readonly name: string;
  readonly token: string;
  readonly schema_json: string;
  readonly request_json: string | null;
  readonly watch_json: string | null;
  readonly deadline: string | null;
  readonly opened_at: string;
  /** What it was woken with, once it has been. */
  readonly woke_json: string | null;
}

// Rows keep JSON as text. Everything stored was a JSON value when it was written.
export const jsonText = (value: Schema.Json): string => JSON.stringify(value);
export const jsonValue = (text: string): Schema.Json => JSON.parse(text) as Schema.Json;

const now = Effect.map(DateTime.now, DateTime.formatIso);
// A wake is one write away from its claim. A claim this old without its run moving had none.
const WAKE_REDONE_AFTER = Duration.seconds(30);
// Long enough for a sender's retries, short enough that the table stays small.
// Enough to read what a step said; the page that shows it is not a place for a whole report.
const STEP_RESULT_KEPT = 8_000;
const SIGNAL_IDS_KEPT = Duration.days(7);
const idsKeptUntil = Effect.map(DateTime.now, (at) =>
  DateTime.formatIso(DateTime.addDuration(at, SIGNAL_IDS_KEPT)),
);
// A tuple, so no name or key can be read as part of the other.
const mailAddress = (address: SignalAddress) =>
  JSON.stringify(
    "runId" in address
      ? ["run", address.runId, address.wait]
      : ["key", address.workflow, address.channel],
  );

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
    /** `held` unsaid keeps what the run had: a run put back to paused is still held. */
    readonly runPaused: (runId: string, detail: string, held?: boolean) => Effect.Effect<void>;
    /**
     * A paused run is running again. With `current`, only while that is still the pause: the
     * sweep's deadline was worked out from it. False when the run was not changed.
     */
    readonly runUnpaused: (
      runId: string,
      current?: { readonly pauses: number; readonly updatedAt: string },
    ) => Effect.Effect<boolean>;
    /** The person's resume has reached the engine, so the run no longer waits for one. */
    readonly runUnheld: (runId: string) => Effect.Effect<void>;
    readonly runEnded: (
      runId: string,
      status: "completed" | "stopped" | "skipped" | "cancelled",
      detail: string | null,
      result: Schema.Json,
    ) => Effect.Effect<boolean>;
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
      /** What the engine looks at to end this wait by itself. */
      readonly watchJson: string | null;
      readonly deadline: string | null;
    }) => Effect.Effect<void>;
    readonly waitClosed: (runId: string, name: string) => Effect.Effect<void>;
    /** The wait takes signals again, under a fresh wake: what woke it was not for it. */
    readonly waitReopened: (runId: string, name: string, token: string) => Effect.Effect<void>;
    /** Takes the wait for one signal. False when another signal already has it. */
    /**
     * Claims an open wait for one wake and keeps what it is woken with. False when something else
     * already claimed it. A signal's id is recorded with the claim, so a retry never claims twice.
     */
    readonly waitSignalled: (
      runId: string,
      name: string,
      woke: Schema.Json,
      signalId?: string,
    ) => Effect.Effect<boolean>;
    /** Waits claimed a while ago whose runs are still not past them: their wake is redone. */
    readonly waitsToWake: Effect.Effect<ReadonlyArray<WaitRow>>;
    /** The run's waits that were claimed and are still open, whose wakes a resume sends. */
    readonly waitsClaimed: (runId: string) => Effect.Effect<ReadonlyArray<WaitRow>>;
    /**
     * Hands one buffered signal to one wait, or to none: the claim and the removal happen
     * together. `gone` when another wait took the signal, `claimed` when the wait was already woken.
     */
    readonly mailDeliver: (
      signalId: string,
      runId: string,
      name: string,
      woke: Schema.Json,
    ) => Effect.Effect<"delivered" | "gone" | "claimed">;
    /** Runs that were not ended while the run that invoked them was cancelled. */
    readonly orphans: Effect.Effect<ReadonlyArray<RunRow>>;
    /** Every run in this state, however many: the sweep must not miss old ones past a page. */
    readonly everyRun: (
      status: "running" | "waiting" | "paused",
    ) => Effect.Effect<ReadonlyArray<RunRow>>;
    /** What each run that has not ended is a run of, with no limit. */
    readonly unfinished: Effect.Effect<
      ReadonlyArray<{ readonly workflow: string; readonly version: number }>
    >;
    /** Whether a signal with this id already woke a wait. */
    readonly signalSeen: (signalId: string) => Effect.Effect<boolean>;
    /** Counts one more arrival at `name` in this run and returns the count. */
    readonly mark: (runId: string, name: string) => Effect.Effect<number>;
    /** The runs this one invoked that have not ended. */
    readonly children: (runId: string) => Effect.Effect<ReadonlyArray<RunRow>>;
    /** The steps a cancelled run left in flight are over: nothing will end them. */
    readonly stepsCancelled: (runId: string, except: string) => Effect.Effect<void>;
    /** Cancelled runs whose `onEnd` has not completed and may still be tried, with its tries. */
    readonly runsToEnd: (
      step: string,
      tries: number,
    ) => Effect.Effect<
      ReadonlyArray<
        RunRow & {
          readonly end_attempts: number | bigint | null;
          readonly end_ended_at: string | null;
        }
      >
    >;
    /** Cancelled runs with a step other than `except` still going: their cancel was cut short. */
    readonly cancelsCutShort: (except: string) => Effect.Effect<ReadonlyArray<RunRow>>;
    /** Ended runs whose parent still waits to hear of it. */
    readonly untold: Effect.Effect<ReadonlyArray<RunRow>>;
    readonly stepThread: (
      runId: string,
      name: string,
      threadId: string,
      environment: string | null,
      turnId: string,
    ) => Effect.Effect<void>;
    /** The threads of agent steps still running in this run, with each step's own turn. */
    readonly runningThreads: (runId: string) => Effect.Effect<
      ReadonlyArray<{
        readonly threadId: string;
        readonly environment?: string;
        readonly turnId?: string;
      }>
    >;
    readonly waitAt: (address: SignalAddress) => Effect.Effect<WaitRow | undefined>;
    /** Every open wait on `key`, in one workflow or in all of them. */
    readonly waitsOn: (
      key: string,
      workflow: string | undefined,
    ) => Effect.Effect<ReadonlyArray<WaitRow>>;
    readonly waitsPastDeadline: Effect.Effect<ReadonlyArray<WaitRow>>;
    readonly requests: Effect.Effect<ReadonlyArray<WaitRow>>;
    /** Open waits the engine ends by looking at something. */
    readonly watches: Effect.Effect<ReadonlyArray<WaitRow>>;
    /** The thread of the run's latest agent step, if it has had one. */
    readonly latestThread: (
      runId: string,
    ) => Effect.Effect<{ readonly threadId: string; readonly environmentId: string | null } | null>;
    readonly counts: Effect.Effect<WorkflowCounts>;
    /** Keep what a step produced for a person to read. A large value is kept as its start. */
    readonly stepResult: (
      runId: string,
      name: string,
      value: Schema.Json,
      /** What an agent said in closing, when its result is data and not that reply. */
      said?: string,
    ) => Effect.Effect<void>;
    /** Say something about a step that is under way, such as when its sleep ends. */
    readonly stepDetail: (runId: string, name: string, detail: string) => Effect.Effect<void>;
    readonly mailPut: (mail: {
      readonly signalId: string;
      readonly address: SignalAddress;
      readonly valueJson: string;
      readonly expiresAt: string;
    }) => Effect.Effect<void>;
    /** The oldest signal kept for any of these addresses, but `passed`. It stays until `mailDelete`. */
    readonly mailNext: (
      addresses: ReadonlyArray<SignalAddress>,
      passed?: ReadonlySet<string>,
    ) => Effect.Effect<
      | {
          readonly signalId: string;
          readonly valueJson: string;
          readonly address: SignalAddress;
        }
      | undefined
    >;
    readonly mailDelete: (signalId: string) => Effect.Effect<void>;
    readonly mailExpire: Effect.Effect<void>;
    readonly run: (runId: string) => Effect.Effect<RunRow | undefined>;
    /** The run a workflow was started as under `key`, of whichever version. */
    readonly runByKey: (workflow: string, key: string) => Effect.Effect<RunRow | undefined>;
    readonly runs: (status: WorkflowRunStatus | undefined) => Effect.Effect<ReadonlyArray<RunRow>>;
    /** Runs by what they are a run of and what they were started as, newest first. */
    readonly runsWhere: (filter: {
      readonly workflow?: string | undefined;
      readonly status?: WorkflowRunStatus | undefined;
      readonly keyPrefix?: string | undefined;
    }) => Effect.Effect<ReadonlyArray<RunRow>>;
    readonly triggerNext: (triggerId: string) => Effect.Effect<string | undefined>;
    readonly triggerSet: (triggerId: string, nextAt: string) => Effect.Effect<void>;
    /** Forgets every trigger but these, so one that comes back starts over. */
    readonly triggersKeep: (triggerIds: ReadonlyArray<string>) => Effect.Effect<void>;
    /** The hook's token: the one kept for it, or `fresh` from now on. */
    readonly hookToken: (hookId: string, fresh: string) => Effect.Effect<string>;
    readonly steps: (runId: string) => Effect.Effect<ReadonlyArray<StepRow>>;
  }
>()("t3/workflows/WorkflowStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<string>();
  // A write here is bookkeeping for a run the engine already journaled: failing it would park a
  // healthy run, so a database that cannot take it is a defect of the process instead.
  const write = <A, E>(runId: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.orDie, Effect.andThen(PubSub.publish(changes, runId)), Effect.asVoid);
  const waitColumns = sql`run_id, name, token, schema_json, request_json, watch_json, deadline, opened_at, woke_json`;

  return WorkflowStore.of({
    changes,
    runStarted: Effect.fn("WorkflowStore.runStarted")(function* (run) {
      const at = yield* now;
      // A start under a key that already has its run changes nothing, and tells nobody.
      const inserted = yield* sql`
          INSERT INTO workflow_runs (
            run_id, workflow, version, engine_tag, idempotency_key, title, status, input_json,
            parent_run_id, parent_wait, started_at, updated_at
          ) VALUES (
            ${run.runId}, ${run.workflow}, ${run.version}, ${run.engineTag},
            ${run.idempotencyKey}, ${`${run.workflow} ${run.idempotencyKey}`}, 'running',
            ${jsonText(run.input)}, ${run.parent?.runId ?? null}, ${run.parent?.wait ?? null},
            ${at}, ${at}
          )
          ON CONFLICT DO NOTHING
          RETURNING run_id
        `.pipe(Effect.orDie);
      if (inserted.length > 0) yield* PubSub.publish(changes, run.runId);
    }),
    runStatus: Effect.fn("WorkflowStore.runStatus")(function* (runId, status, detail) {
      const at = yield* now;
      yield* write(
        runId,
        sql`
          UPDATE workflow_runs
          SET status = ${status}, detail = ${detail}, updated_at = ${at}
          WHERE run_id = ${runId} AND ended_at IS NULL AND status != 'paused'
        `,
      );
    }),
    runResumed: Effect.fn("WorkflowStore.runResumed")(function* (runId) {
      const at = yield* now;
      // One statement, so two of them ending at once cannot leave the run on one that has ended.
      yield* write(
        runId,
        sql`
          WITH out AS (
            SELECT CASE WHEN kind IN ('agent', 'sleep') THEN kind || ' ' || name ELSE name END
              AS detail
            FROM workflow_steps
            WHERE run_id = ${runId} AND status = 'running'
              AND kind IN ('wait', 'ask', 'agent', 'sleep')
            ORDER BY started_at, rowid LIMIT 1
          )
          UPDATE workflow_runs
          SET status = CASE WHEN EXISTS (SELECT 1 FROM out) THEN 'waiting' ELSE 'running' END,
              detail = (SELECT detail FROM out), updated_at = ${at}
          WHERE run_id = ${runId} AND ended_at IS NULL AND status != 'paused'
        `,
      );
    }),
    runPaused: Effect.fn("WorkflowStore.runPaused")(function* (runId, detail, held) {
      const at = yield* now;
      yield* write(
        runId,
        sql`
          UPDATE workflow_runs
          SET status = 'paused', detail = ${detail.slice(0, 2000)}, pauses = pauses + 1,
            held = ${held === undefined ? sql`held` : held ? 1 : 0}, updated_at = ${at}
          WHERE run_id = ${runId} AND ended_at IS NULL AND status != 'paused'
        `,
      );
    }),
    runUnpaused: Effect.fn("WorkflowStore.runUnpaused")(function* (runId, current) {
      const at = yield* now;
      const rows = yield* sql`
        UPDATE workflow_runs SET status = 'running', detail = NULL, updated_at = ${at}
        WHERE run_id = ${runId} AND ended_at IS NULL AND status = 'paused'
          AND (${current === undefined ? 1 : 0} = 1
            OR (pauses = ${current?.pauses ?? 0} AND updated_at = ${current?.updatedAt ?? ""}))
        RETURNING run_id
      `.pipe(Effect.orDie);
      yield* PubSub.publish(changes, runId);
      return rows.length > 0;
    }),
    runUnheld: Effect.fn("WorkflowStore.runUnheld")(function* (runId) {
      // A pause since then set its own `held`.
      yield* write(
        runId,
        sql`UPDATE workflow_runs SET held = 0 WHERE run_id = ${runId} AND status != 'paused'`,
      );
    }),
    runEnded: Effect.fn("WorkflowStore.runEnded")(function* (runId, status, detail, result) {
      const at = yield* now;
      const resultJson = jsonText(result);
      // False when another outcome was recorded first: the run ended some other way.
      const ended = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`
              UPDATE workflow_runs
              SET status = ${status}, detail = ${detail}, result_json = ${resultJson},
                  pauses = 0, updated_at = ${at}, ended_at = ${at}
              WHERE run_id = ${runId} AND ended_at IS NULL
              RETURNING run_id
            `;
            yield* sql`DELETE FROM workflow_waits WHERE run_id = ${runId}`;
            return rows.length > 0;
          }),
        )
        .pipe(Effect.orDie);
      yield* PubSub.publish(changes, runId);
      return ended;
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
              ? // Not while paused: a step beside the one that failed is no progress past it.
                sql`
                  UPDATE workflow_runs SET pauses = 0
                  WHERE run_id = ${runId} AND ended_at IS NULL AND status != 'paused'
                `
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
            run_id, name, workflow, token, key, schema_json, request_json, watch_json, deadline,
            opened_at
          ) VALUES (
            ${wait.runId}, ${wait.name}, ${wait.workflow}, ${wait.token}, ${wait.key ?? null},
            ${wait.schemaJson}, ${wait.requestJson}, ${wait.watchJson}, ${wait.deadline}, ${at}
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
    waitReopened: Effect.fn("WorkflowStore.waitReopened")(function* (runId, name, token) {
      yield* write(
        runId,
        sql`
          UPDATE workflow_waits SET token = ${token}, signalled_at = NULL, woke_json = NULL
          WHERE run_id = ${runId} AND name = ${name}
        `,
      );
    }),
    waitSignalled: Effect.fn("WorkflowStore.waitSignalled")(
      function* (runId, name, woke, signalId) {
        const at = yield* now;
        const taken = yield* sql`
          UPDATE workflow_waits SET signalled_at = ${at}, woke_json = ${jsonText(woke)}
          WHERE run_id = ${runId} AND name = ${name} AND signalled_at IS NULL
          RETURNING name
        `;
        if (taken.length > 0 && signalId !== undefined) {
          const receipt = yield* sql`
            INSERT INTO workflow_signals (signal_id, kept_until)
            VALUES (${signalId}, MAX(${yield* idsKeptUntil}, COALESCE(
              (SELECT expires_at FROM workflow_mail WHERE signal_id = ${signalId}), ''
            )))
            ON CONFLICT (signal_id) DO NOTHING
            RETURNING signal_id
          `;
          // The id already woke a wait, so this one is not claimed: the transaction undoes it.
          if (receipt.length === 0) return yield* Effect.fail("seen" as const);
        }
        return taken.length > 0;
      },
      (effect) =>
        sql.withTransaction(effect).pipe(
          Effect.catchIf(
            (error) => error === "seen",
            () => Effect.succeed(false),
          ),
          Effect.orDie,
        ),
    ),
    waitsToWake: Effect.gen(function* () {
      const before = DateTime.formatIso(
        DateTime.subtractDuration(yield* DateTime.now, WAKE_REDONE_AFTER),
      );
      return yield* sql<WaitRow>`
        SELECT ${waitColumns} FROM workflow_waits
        WHERE woke_json IS NOT NULL AND signalled_at <= ${before}
          AND run_id IN (SELECT run_id FROM workflow_runs WHERE ended_at IS NULL)
      `.pipe(Effect.orDie);
    }),
    waitsClaimed: Effect.fn("WorkflowStore.waitsClaimed")(function* (runId) {
      return yield* sql<WaitRow>`
        SELECT ${waitColumns} FROM workflow_waits WHERE run_id = ${runId} AND woke_json IS NOT NULL
      `.pipe(Effect.orDie);
    }),
    mailDeliver: Effect.fn("WorkflowStore.mailDeliver")(function* (signalId, runId, name, woke) {
      const at = yield* now;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // A kept copy of an id that already woke a wait straight is spent: it is dropped, so
            // it wakes no second wait and is not offered again.
            const seen = yield* sql`SELECT 1 FROM workflow_signals WHERE signal_id = ${signalId}`;
            if (seen.length > 0) {
              yield* sql`DELETE FROM workflow_mail WHERE signal_id = ${signalId}`;
              return "gone" as const;
            }
            const claimed = yield* sql`
              UPDATE workflow_waits SET signalled_at = ${at}, woke_json = ${jsonText(woke)}
              WHERE run_id = ${runId} AND name = ${name} AND signalled_at IS NULL
              RETURNING name
            `;
            if (claimed.length === 0) return "claimed" as const;
            const taken = yield* sql<{ expires_at: string }>`
              DELETE FROM workflow_mail WHERE signal_id = ${signalId} RETURNING expires_at
            `;
            // Failing undoes the claim: the wait stays open for a signal that is still there.
            const copy = taken[0];
            if (copy === undefined) return yield* Effect.fail("gone" as const);
            const keep = yield* idsKeptUntil;
            const receipt = yield* sql`
              INSERT INTO workflow_signals (signal_id, kept_until)
              VALUES (${signalId}, ${copy.expires_at > keep ? copy.expires_at : keep})
              ON CONFLICT (signal_id) DO NOTHING
              RETURNING signal_id
            `;
            // Delivered straight in the meantime: undone, and the next look drops the copy above.
            if (receipt.length === 0) return yield* Effect.fail("gone" as const);
            return "delivered" as const;
          }),
        )
        .pipe(
          Effect.catchIf(
            (error) => error === "gone",
            () => Effect.succeed("gone" as const),
          ),
          Effect.orDie,
        );
    }),
    orphans: sql<RunRow>`
      SELECT c.* FROM workflow_runs c
      JOIN workflow_runs p ON p.run_id = c.parent_run_id
      WHERE c.ended_at IS NULL AND p.status = 'cancelled'
    `.pipe(Effect.orDie),
    unfinished: sql<{ workflow: string; version: number | bigint }>`
      SELECT workflow, version FROM workflow_runs WHERE ended_at IS NULL
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ workflow: row.workflow, version: Number(row.version) })),
      ),
      Effect.orDie,
    ),
    everyRun: Effect.fn("WorkflowStore.everyRun")(function* (status) {
      return yield* sql<RunRow>`SELECT * FROM workflow_runs WHERE status = ${status}`.pipe(
        Effect.orDie,
      );
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
    stepsCancelled: Effect.fn("WorkflowStore.stepsCancelled")(function* (runId, except) {
      const at = yield* now;
      yield* write(
        runId,
        sql`
          UPDATE workflow_steps SET status = 'failed', detail = 'cancelled', ended_at = ${at}
          WHERE run_id = ${runId} AND status = 'running' AND name != ${except}
        `,
      );
    }),
    runsToEnd: Effect.fn("WorkflowStore.runsToEnd")(function* (step, tries) {
      return yield* sql<
        RunRow & { end_attempts: number | bigint | null; end_ended_at: string | null }
      >`
        SELECT r.*, s.attempts AS end_attempts, s.ended_at AS end_ended_at
        FROM workflow_runs r
        LEFT JOIN workflow_steps s ON s.run_id = r.run_id AND s.name = ${step}
        WHERE r.status = 'cancelled'
          AND (s.status IS NULL OR (s.status != 'completed' AND s.attempts < ${tries}))
      `.pipe(Effect.orDie);
    }),
    cancelsCutShort: Effect.fn("WorkflowStore.cancelsCutShort")(function* (except) {
      return yield* sql<RunRow>`
        SELECT r.* FROM workflow_runs r
        WHERE r.status = 'cancelled' AND EXISTS (
          SELECT 1 FROM workflow_steps s
          WHERE s.run_id = r.run_id AND s.status = 'running' AND s.name != ${except}
        )
      `.pipe(Effect.orDie);
    }),
    untold: sql<RunRow>`
      SELECT c.* FROM workflow_waits w
      JOIN workflow_runs c ON c.parent_run_id = w.run_id AND c.parent_wait = w.name
      WHERE w.signalled_at IS NULL AND c.ended_at IS NOT NULL
    `.pipe(Effect.orDie),
    stepThread: Effect.fn("WorkflowStore.stepThread")(
      function* (runId, name, threadId, environment, turnId) {
        yield* write(
          runId,
          sql`
          UPDATE workflow_steps
          SET thread_id = ${threadId}, environment_id = ${environment}, turn_id = ${turnId}
          WHERE run_id = ${runId} AND name = ${name}
        `,
        );
      },
    ),
    runningThreads: Effect.fn("WorkflowStore.runningThreads")(function* (runId) {
      const rows = yield* sql<{
        thread_id: string;
        environment_id: string | null;
        turn_id: string | null;
      }>`
        SELECT thread_id, environment_id, turn_id FROM workflow_steps
        WHERE run_id = ${runId} AND status = 'running' AND thread_id IS NOT NULL
      `.pipe(Effect.orDie);
      return rows.map((row) => ({
        threadId: row.thread_id,
        ...(row.environment_id === null ? {} : { environment: row.environment_id }),
        ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
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
              WHERE workflow = ${address.workflow} AND key = ${address.channel} AND signalled_at IS NULL
              ORDER BY opened_at LIMIT 1
            `
      ).pipe(Effect.orDie);
      return rows[0];
    }),
    waitsOn: Effect.fn("WorkflowStore.waitsOn")(function* (key, workflow) {
      return yield* sql<WaitRow>`
        SELECT ${waitColumns} FROM workflow_waits
        WHERE key = ${key} AND signalled_at IS NULL
          AND (${workflow ?? null} IS NULL OR workflow = ${workflow ?? null})
        ORDER BY opened_at
      `.pipe(Effect.orDie);
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
    stepResult: Effect.fn("WorkflowStore.stepResult")(function* (runId, name, value, said) {
      const full = jsonText(value);
      const kept =
        full.length <= STEP_RESULT_KEPT ? full : jsonText(`${full.slice(0, STEP_RESULT_KEPT)}…`);
      const words = said?.trim() ?? "";
      const keptSaid =
        words === ""
          ? null
          : words.length <= STEP_RESULT_KEPT
            ? words
            : `${words.slice(0, STEP_RESULT_KEPT)}…`;
      yield* sql`
        UPDATE workflow_steps SET result_json = ${kept}, said = ${keptSaid}
        WHERE run_id = ${runId} AND name = ${name}
      `.pipe(Effect.orDie);
    }),
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
    watches: sql<WaitRow>`
      SELECT ${waitColumns} FROM workflow_waits
      WHERE watch_json IS NOT NULL AND signalled_at IS NULL ORDER BY opened_at
    `.pipe(Effect.orDie),
    mailPut: Effect.fn("WorkflowStore.mailPut")(function* (mail) {
      yield* sql
        .withTransaction(
          Effect.andThen(
            sql`
              INSERT INTO workflow_mail (signal_id, address, value_json, expires_at)
              VALUES (${mail.signalId}, ${mailAddress(mail.address)}, ${mail.valueJson}, ${mail.expiresAt})
              ON CONFLICT (signal_id) DO NOTHING
            `,
            // A copy kept by a retry that raced the first delivery outlives no receipt of it.
            sql`
              UPDATE workflow_signals SET kept_until = ${mail.expiresAt}
              WHERE signal_id = ${mail.signalId} AND kept_until < ${mail.expiresAt}
            `,
          ),
        )
        .pipe(Effect.orDie);
    }),
    mailNext: Effect.fn("WorkflowStore.mailNext")(function* (addresses, passed = new Set()) {
      for (const address of addresses) {
        const rows = yield* sql<{ signal_id: string; value_json: string }>`
          SELECT signal_id, value_json FROM workflow_mail
          WHERE address = ${mailAddress(address)} ORDER BY rowid
        `.pipe(Effect.orDie);
        const mail = rows.find((row) => !passed.has(row.signal_id));
        if (mail !== undefined) {
          return { signalId: mail.signal_id, valueJson: mail.value_json, address };
        }
      }
      return undefined;
    }),
    mailDelete: Effect.fn("WorkflowStore.mailDelete")(function* (signalId) {
      yield* sql`DELETE FROM workflow_mail WHERE signal_id = ${signalId}`.pipe(Effect.orDie);
    }),
    mailExpire: Effect.gen(function* () {
      const at = yield* DateTime.now;
      yield* sql`DELETE FROM workflow_mail WHERE expires_at <= ${DateTime.formatIso(at)}`;
      yield* sql`DELETE FROM workflow_signals WHERE kept_until <= ${DateTime.formatIso(at)}`;
    }).pipe(Effect.orDie),
    run: Effect.fn("WorkflowStore.run")(function* (runId) {
      const rows = yield* sql<RunRow>`SELECT * FROM workflow_runs WHERE run_id = ${runId}`.pipe(
        Effect.orDie,
      );
      return rows[0];
    }),
    runByKey: Effect.fn("WorkflowStore.runByKey")(function* (workflow, key) {
      const rows = yield* sql<RunRow>`
        SELECT * FROM workflow_runs WHERE workflow = ${workflow} AND idempotency_key = ${key}
        ORDER BY started_at LIMIT 1
      `.pipe(Effect.orDie);
      return rows[0];
    }),
    runsWhere: Effect.fn("WorkflowStore.runsWhere")(function* (filter) {
      const prefix = filter.keyPrefix ?? null;
      // A range, not LIKE, which would read `%` and `_` in a key as patterns.
      return yield* sql<RunRow>`
        SELECT * FROM workflow_runs
        WHERE (${filter.workflow ?? null} IS NULL OR workflow = ${filter.workflow ?? null})
          AND (${filter.status ?? null} IS NULL OR status = ${filter.status ?? null})
          AND (${prefix} IS NULL OR (
            idempotency_key >= ${prefix} AND idempotency_key < ${`${prefix ?? ""}\u{10FFFF}`}
          ))
        ORDER BY started_at DESC, rowid DESC LIMIT 500
      `.pipe(Effect.orDie);
    }),
    runs: Effect.fn("WorkflowStore.runs")(function* (status) {
      return yield* (
        status === undefined
          ? // Skipped runs are counted apart, so a trigger that skips most of what it brings does
            // not push the runs that did something out of the list.
            sql<RunRow>`
              SELECT * FROM (
                SELECT * FROM workflow_runs
                WHERE NOT (status = 'skipped' AND parent_run_id IS NULL)
                ORDER BY started_at DESC LIMIT 500
              )
              UNION ALL
              SELECT * FROM (
                SELECT * FROM workflow_runs
                WHERE status = 'skipped' AND parent_run_id IS NULL
                ORDER BY started_at DESC LIMIT 500
              )
              ORDER BY started_at DESC
            `
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
    triggersKeep: Effect.fn("WorkflowStore.triggersKeep")(function* (triggerIds) {
      const kept = yield* sql<{ trigger_id: string }>`SELECT trigger_id FROM workflow_triggers`;
      for (const { trigger_id } of kept) {
        if (triggerIds.includes(trigger_id)) continue;
        yield* sql`DELETE FROM workflow_triggers WHERE trigger_id = ${trigger_id}`;
      }
    }, Effect.orDie),
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
        SELECT name, kind, status, attempts, detail, thread_id, environment_id, result_json,
               said, started_at, ended_at
        FROM workflow_steps WHERE run_id = ${runId} ORDER BY started_at, rowid
      `.pipe(Effect.orDie);
    }),
  });
});

export const layer = Layer.effect(WorkflowStore, make);

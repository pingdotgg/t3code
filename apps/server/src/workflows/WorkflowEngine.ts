// The workflow service on Effect's workflow engine. Loaded only when workflows are enabled: the
// engine's modules are not worth their load time on a server that registers none.
import * as Cause from "effect/Cause";
import { ClusterWorkflowEngine, SingleRunner } from "effect/cluster";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { DurableDeferred, type WorkflowEngine } from "effect/workflow";

import { checkOutput } from "../orchestration-v2/runOutput.ts";
import {
  type EngineWorkflow,
  engineTag,
  engineWorkflow,
  layerDefinition,
  text,
  wakeOf,
  type Woke,
  type WorkflowDefinition,
} from "./workflow.ts";
import { WorkflowAgents } from "./WorkflowAgents.ts";
import {
  WorkflowInputError,
  WorkflowNotRegisteredError,
  WorkflowRunNotFoundError,
  Workflows,
} from "./Workflows.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

const SWEEP_EVERY = Duration.seconds(15);
const DEFAULT_SIGNAL_TTL = Duration.days(7);
const RESUME_LOOK_EVERY = Duration.millis(25);
const RESUME_LOOKS = 80;
const WATCH_SETTLE = Duration.millis(100);

const make = Effect.fn("WorkflowEngine.make")(function* (
  registered: ReadonlyArray<readonly [WorkflowDefinition, EngineWorkflow]>,
) {
  const store = yield* WorkflowStore.WorkflowStore;
  const agents = yield* WorkflowAgents;
  const context = yield* Effect.context<WorkflowEngine.WorkflowEngine>();
  // The engine keeps 64-bit ids, which this SQLite client only reads when asked for BigInts.
  const withEngine = <A, E>(effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>) =>
    effect.pipe(
      Effect.provideContext(context),
      Effect.provideService(SqlClient.SafeIntegers, true),
    );
  const byTag = new Map(registered.map(([, engine]) => [engine._tag, engine] as const));
  const definitionByTag = new Map(
    registered.map(([definition]) => [engineTag(definition), definition] as const),
  );
  const latest = (name: string) =>
    registered
      .filter(([definition]) => definition.name === name)
      .toSorted(([left], [right]) => right.version - left.version)[0];

  const toRun = (row: WorkflowStore.RunRow): WorkflowStore.WorkflowRun => ({
    runId: row.run_id,
    workflow: row.workflow,
    version: Number(row.version),
    title: row.title,
    status: row.status,
    detail: row.detail,
    result: row.result_json === null ? null : WorkflowStore.jsonValue(row.result_json),
    pauses: Number(row.pauses),
    retired: row.ended_at === null && !byTag.has(row.engine_tag),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  });
  const requireRun = Effect.fn("WorkflowEngine.requireRun")(function* (runId: string) {
    const row = yield* store.run(runId);
    if (row === undefined) return yield* new WorkflowRunNotFoundError({ runId });
    return row;
  });
  const wake = (wait: WorkflowStore.WaitRow, value: typeof Woke.Type) =>
    withEngine(
      DurableDeferred.succeed(wakeOf(wait.name), {
        token: wait.token as DurableDeferred.Token,
        value,
      }),
    );

  const resume: Workflows["Service"]["resume"] = Effect.fn("Workflows.resume")(function* (runId) {
    const row = yield* requireRun(runId);
    const engine = byTag.get(row.engine_tag);
    if (engine === undefined) {
      return yield* new WorkflowNotRegisteredError({ workflow: row.engine_tag });
    }
    if (row.ended_at !== null) return;
    // Marked first: once the engine is resumed, the step may fail again and pause the run, and
    // that must be the last word. A crash in between leaves `running`, which the sweep corrects.
    if (row.status === "paused") yield* store.runStatus(runId, "running", null);
    // The step marks its run paused from inside the engine, a moment before the engine records
    // the failure. Resuming in that moment would do nothing, so the record is waited for.
    yield* withEngine(engine.poll(runId)).pipe(
      Effect.repeat({
        until: (result) => Option.isSome(result) && result.value._tag === "Suspended",
        schedule: Schedule.spaced(RESUME_LOOK_EVERY),
        times: RESUME_LOOKS,
      }),
    );
    yield* withEngine(engine.resume(runId));
  });

  /** A run the engine holds as failed while its row still says running: paused, after all. */
  const reconcile = Effect.fn("WorkflowEngine.reconcile")(function* (row: WorkflowStore.RunRow) {
    const engine = byTag.get(row.engine_tag);
    if (engine === undefined) return;
    const result = yield* withEngine(engine.poll(row.run_id));
    if (Option.isNone(result) || result.value._tag !== "Suspended") return;
    if (result.value.failed !== true) return;
    const cause = result.value.cause;
    yield* store.runPaused(
      row.run_id,
      cause === undefined ? "A step failed." : text(Cause.squash(cause)),
    );
  });

  const sweep: Workflows["Service"]["sweep"] = Effect.gen(function* () {
    for (const wait of yield* store.waitsPastDeadline) {
      if (yield* store.waitSignalled(wait.run_id, wait.name)) {
        yield* wake(wait, { expired: true, value: null });
      }
    }
    yield* store.mailExpire;
    for (const row of yield* store.runs("running")) yield* reconcile(row);
    const at = yield* DateTime.now;
    for (const row of yield* store.runs("paused")) {
      const rest = definitionByTag.get(row.engine_tag)?.resumeAfter[Number(row.pauses) - 1];
      if (rest === undefined) continue;
      const since = DateTime.makeUnsafe(row.updated_at);
      if (DateTime.isLessThan(at, DateTime.addDuration(since, Duration.fromInputUnsafe(rest)))) {
        continue;
      }
      yield* Effect.ignore(resume(row.run_id));
    }
  }).pipe(Effect.withSpan("Workflows.sweep"));

  yield* sweep.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Workflow sweep failed", cause)),
    Effect.andThen(Effect.sleep(SWEEP_EVERY)),
    Effect.forever,
    Effect.forkScoped,
  );

  const questions = Effect.map(store.requests, (waits) =>
    waits.flatMap((wait) =>
      wait.request_json === null
        ? []
        : [
            {
              runId: wait.run_id,
              name: wait.name,
              request: WorkflowStore.jsonValue(wait.request_json),
              askedAt: wait.opened_at,
            },
          ],
    ),
  );
  const snapshot = Effect.all({
    runs: Effect.map(store.runs(undefined), (rows) => rows.map(toRun)),
    questions,
  });
  const watch: Workflows["Service"]["watch"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribed before the first look, so a change in between is not missed.
      const changes = yield* PubSub.subscribe(store.changes);
      return Stream.concat(
        Stream.fromEffect(snapshot),
        // A run writes several rows per step; one list answers a burst of them.
        Stream.fromSubscription(changes).pipe(
          Stream.debounce(WATCH_SETTLE),
          Stream.mapEffect(() => snapshot),
        ),
      );
    }),
  );

  return Workflows.of({
    start: Effect.fn("Workflows.start")(function* (name, input, options) {
      const found = latest(name);
      if (found === undefined) return yield* new WorkflowNotRegisteredError({ workflow: name });
      const [definition, engine] = found;
      const payloadCodec = Schema.toCodecJson(definition.payload);
      const encode = Schema.encodeUnknownEffect(payloadCodec);
      const encoded = yield* encode(input).pipe(
        Effect.mapError(
          (error) =>
            new WorkflowInputError({
              problem: `The payload does not fit workflow ${name}: ${text(error)}`,
            }),
        ),
      );
      const payload = { idempotencyKey: options.idempotencyKey, input: encoded as Schema.Json };
      const runId = yield* withEngine(engine.execute(payload, { discard: true }));
      // Listed at once: the run's own first step writes the same row when it gets to run.
      yield* store.runStarted({
        runId,
        workflow: definition.name,
        version: definition.version,
        engineTag: engineTag(definition),
        idempotencyKey: options.idempotencyKey,
      });
      return { runId };
    }),
    signal: Effect.fn("Workflows.signal")(function* (address, value, options) {
      // A sender's retry of a signal that already woke a wait is not a second signal.
      if (yield* store.signalSeen(options.id)) return "delivered" as const;
      const valueJson = WorkflowStore.jsonText(value);
      const wait = yield* store.waitAt(address);
      if (wait !== undefined) {
        const schema = WorkflowStore.jsonValue(wait.schema_json) as Record<string, Schema.Json>;
        const checked = yield* checkOutput(schema, valueJson);
        if (Result.isFailure(checked)) {
          return yield* new WorkflowInputError({
            problem: `The value does not fit what ${wait.name} waits for:\n${checked.failure}`,
          });
        }
        // One signal per wait: a second one for the same key is for the next run that waits on it.
        if (yield* store.waitSignalled(wait.run_id, wait.name)) {
          yield* store.signalDelivered(options.id);
          yield* wake(wait, { expired: false, value });
          return "delivered" as const;
        }
      }
      const expiresAt = DateTime.formatIso(
        DateTime.addDuration(
          yield* DateTime.now,
          Duration.fromInputUnsafe(options.ttl ?? DEFAULT_SIGNAL_TTL),
        ),
      );
      yield* store.mailPut({ signalId: options.id, address, valueJson, expiresAt });
      return "buffered" as const;
    }),
    resume,
    cancel: Effect.fn("Workflows.cancel")(function* (runId, reason) {
      const row = yield* requireRun(runId);
      if (row.ended_at !== null) return;
      const threads = yield* store.runningThreads(runId);
      // Ended first, so nothing the run still does can be recorded as its outcome.
      yield* store.runEnded(runId, "cancelled", reason, null);
      const engine = byTag.get(row.engine_tag);
      if (engine !== undefined) yield* withEngine(engine.interrupt(runId));
      // A step in flight cannot be interrupted, so the agent it waits on is stopped instead.
      yield* Effect.forEach(threads, (thread) => Effect.ignore(agents.interrupt(thread)), {
        discard: true,
      });
    }),
    get: Effect.fn("Workflows.get")(function* (runId) {
      const row = yield* requireRun(runId);
      const steps = yield* store.steps(runId);
      return {
        run: toRun(row),
        steps: steps.map((step) => ({
          name: step.name,
          kind: step.kind,
          status: step.status,
          attempts: Number(step.attempts),
          detail: step.detail,
          threadId: step.thread_id,
          startedAt: step.started_at,
          endedAt: step.ended_at,
        })),
      };
    }),
    list: Effect.fn("Workflows.list")(function* (filter) {
      return (yield* store.runs(filter?.status)).map(toRun);
    }),
    waitFor: Effect.fn("Workflows.waitFor")(function* (runId, done) {
      // Subscribed before the first look, so a change in between is not missed.
      const changes = yield* PubSub.subscribe(store.changes);
      while (true) {
        const row = yield* store.run(runId);
        if (row !== undefined && done(toRun(row))) return toRun(row);
        yield* Effect.repeat(PubSub.take(changes), { until: (changed) => changed === runId });
      }
    }, Effect.scoped),
    questions,
    watch,
    sweep,
  });
});

/**
 * The workflow service with these definitions registered, on the SQLite database provided to it.
 * Only one process may run this layer against a database.
 */
export const layer = (definitions: ReadonlyArray<WorkflowDefinition>) => {
  const registered = definitions.map(
    (definition) => [definition, engineWorkflow(definition)] as const,
  );
  const layerDefinitions = Layer.mergeAll(
    Layer.empty,
    ...registered.map(([definition, engine]) => layerDefinition(definition, engine)),
  );
  return Layer.effect(Workflows, make(registered)).pipe(
    Layer.provide(layerDefinitions),
    Layer.provide(WorkflowStore.layer),
    Layer.provide(ClusterWorkflowEngine.layer),
    Layer.provide(SingleRunner.layer({ runnerStorage: "sql" })),
    Layer.provide(Layer.succeed(SqlClient.SafeIntegers, true)),
  );
};

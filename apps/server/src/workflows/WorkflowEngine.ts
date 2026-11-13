// The workflow service on Effect's workflow engine. Loaded only when workflows are enabled: the
// engine's modules are not worth their load time on a server that registers none.
import * as Cause from "effect/Cause";
import { ClusterWorkflowEngine, SingleRunner } from "effect/cluster";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { DurableDeferred, type WorkflowEngine } from "effect/workflow";

import { checkOutput } from "../orchestration-v2/runOutput.ts";
import { isMissedFixedTimeRun, nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";
import { constantTimeEquals } from "../scheduledTasks/webhookVerification.ts";
import {
  END_STEP,
  type EngineWorkflow,
  engineTag,
  engineWorkflow,
  layerDefinition,
  text,
  wakeOf,
  type Woke,
  type WorkflowDefinition,
} from "./workflow.ts";
import { forStep, KeyValues, layerKeyValues, EngineLink, layerEngineLink } from "./stepServices.ts";
import { WorkflowAgents } from "./WorkflowAgents.ts";
import {
  HOOK_PREFIX,
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
const END_TRIES = 5;
const CANCEL_WAITS = Duration.seconds(30);
// Times of day are the server's own, as they are for scheduled tasks.
const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

const make = Effect.fn("WorkflowEngine.make")(function* (
  registered: ReadonlyArray<readonly [WorkflowDefinition, EngineWorkflow]>,
) {
  const store = yield* WorkflowStore.WorkflowStore;
  const keyValues = yield* KeyValues;
  const link = yield* EngineLink;
  const scope = yield* Scope.Scope;
  const agents = yield* WorkflowAgents;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
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
    parentRunId: row.parent_run_id,
    parentStep: row.parent_wait,
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

  const start: Workflows["Service"]["start"] = Effect.fn("Workflows.start")(
    function* (name, input, options) {
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
        input: payload.input,
        parent: options.parent,
      });
      if (options.parent !== undefined) {
        // The key named a run that someone else started: it would never tell this parent.
        const row = yield* store.run(runId);
        if (
          row?.parent_run_id !== options.parent.runId ||
          row.parent_wait !== options.parent.wait
        ) {
          return yield* new WorkflowInputError({
            problem: `Run ${runId} of ${name} was started by something else under this key, so it cannot be invoked. Give the invoke a key of its own.`,
          });
        }
      }
      return { runId };
    },
  );

  const latestDefinitions = [...new Set(registered.map(([definition]) => definition.name))].map(
    (name) => latest(name)![0],
  );
  /** Start what each schedule is due for, once, however long ago that was. */
  const fireSchedules = Effect.gen(function* () {
    const now = yield* localNow;
    for (const definition of latestDefinitions) {
      for (const trigger of definition.triggers) {
        if (trigger.kind !== "schedule") continue;
        const id = `${definition.name}/${trigger.id}`;
        const due = yield* store.triggerNext(id);
        if (due !== undefined) {
          const dueAt = DateTime.makeUnsafe(due);
          if (DateTime.isLessThan(now, dueAt)) continue;
          if (!isMissedFixedTimeRun(trigger.schedule, dueAt, now)) {
            // The key is the time it was due, so a crash before the next line starts no second run.
            yield* start(
              definition.name,
              { scheduledAt: due },
              { idempotencyKey: `trigger:${id}:${due}` },
            ).pipe(
              Effect.catch((error) =>
                Effect.logWarning("A scheduled workflow run did not start", { trigger: id, error }),
              ),
            );
          }
        }
        const next = nextScheduledRunAt(trigger.schedule, now);
        if (next !== null) {
          yield* store.triggerSet(id, DateTime.formatIso(DateTime.toUtc(next)));
        }
      }
    }
  });

  const hooks = yield* Effect.forEach(
    latestDefinitions.flatMap((definition) =>
      definition.triggers.flatMap((trigger) =>
        trigger.kind === "webhook" ? [{ definition, trigger }] : [],
      ),
    ),
    Effect.fnUntraced(function* ({ definition, trigger }) {
      const hookId = `${HOOK_PREFIX}${definition.name}.${trigger.name}`;
      const token = yield* store.hookToken(hookId, yield* random.uuidV4());
      return {
        hookId,
        token,
        trigger,
        workflow: definition.name,
        name: trigger.name,
        path: `/api/hooks/${encodeURIComponent(hookId)}/${token}`,
      };
    }),
  );
  const deliver: Workflows["Service"]["deliver"] = Effect.fn("Workflows.deliver")(
    function* (delivery) {
      const hook = hooks.find((candidate) => candidate.hookId === delivery.hookId);
      // A wrong token reads the same as an unknown hook, so the URL does not say which exist.
      const known =
        hook !== undefined &&
        (yield* constantTimeEquals(delivery.token, hook.token).pipe(
          Effect.provideService(Digest.Digest, digest),
          Effect.orElseSucceed(() => false),
        ));
      if (!known) return Option.none();
      const key =
        hook.trigger.key?.(delivery.request) ?? delivery.deliveryId ?? (yield* random.uuidV4());
      return Option.some(
        yield* start(hook.workflow, delivery.request, {
          idempotencyKey: `hook:${hook.hookId}:${key}`,
        }),
      );
    },
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

  // A cancelled run's body is gone, so its `onEnd` runs here, outside the engine. The sweep asks
  // again after a failure or a restart, and `ending` keeps the two from running it at once.
  const ending = new Set<string>();
  const endCancelled = Effect.fn("WorkflowEngine.endCancelled")(function* (
    row: WorkflowStore.RunRow,
  ) {
    const definition = definitionByTag.get(row.engine_tag);
    if (definition?.onEnd === undefined || ending.has(row.run_id)) return;
    const onEnd = definition.onEnd;
    ending.add(row.run_id);
    yield* store.stepStarted(row.run_id, END_STEP, "step");
    const payloadCodec = Schema.toCodecJson(definition.payload);
    const decode = Schema.decodeEffect(payloadCodec);
    yield* decode(row.input_json === null ? null : WorkflowStore.jsonValue(row.input_json)).pipe(
      Effect.flatMap((input) =>
        onEnd(input as never, {
          id: row.run_id,
          outcome: "cancelled",
          reason: row.detail ?? undefined,
        }),
      ),
      Effect.provideContext(forStep(keyValues, link, `${row.run_id}/${END_STEP}`)),
      Effect.matchCauseEffect({
        onSuccess: () => store.stepEnded(row.run_id, END_STEP, "completed", null),
        onFailure: (cause) =>
          store.stepEnded(row.run_id, END_STEP, "failed", text(Cause.squash(cause))),
      }),
      Effect.ensuring(Effect.sync(() => ending.delete(row.run_id))),
    );
  });

  const sweep: Workflows["Service"]["sweep"] = Effect.gen(function* () {
    for (const wait of yield* store.waitsPastDeadline) {
      if (yield* store.waitSignalled(wait.run_id, wait.name)) {
        yield* wake(wait, { expired: true, value: null });
      }
    }
    yield* store.mailExpire;
    yield* fireSchedules;
    for (const row of yield* store.runsToEnd(END_STEP, END_TRIES)) yield* endCancelled(row);
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

  const questions = Effect.flatMap(store.requests, (waits) =>
    Effect.forEach(
      waits.filter((wait) => wait.request_json !== null),
      (wait) =>
        Effect.map(store.latestThread(wait.run_id), (thread) => ({
          runId: wait.run_id,
          name: wait.name,
          request: WorkflowStore.jsonValue(wait.request_json ?? "null"),
          askedAt: wait.opened_at,
          thread,
        })),
    ),
  );
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const triggerText = (trigger: WorkflowDefinition["triggers"][number]) => {
    if (trigger.kind === "webhook") return `webhook ${trigger.name}`;
    if (trigger.schedule.type === "interval") {
      return `every ${Duration.format(Duration.millis(trigger.schedule.everyMs))}`;
    }
    const days = trigger.schedule.weekdays;
    return `daily at ${trigger.schedule.timeOfDay}${
      days === undefined ? "" : ` on ${days.map((day) => WEEKDAYS[day] ?? day).join(", ")}`
    }`;
  };
  const summaries = [...new Set(registered.map(([definition]) => definition.name))].flatMap(
    (name) => {
      const found = latest(name);
      return found === undefined
        ? []
        : [{ name, version: found[0].version, triggers: found[0].triggers.map(triggerText) }];
    },
  );
  const snapshot = Effect.all({
    workflows: Effect.succeed(summaries),
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

  const counts: Workflows["Service"]["counts"] = Stream.unwrap(
    Effect.gen(function* () {
      const changes = yield* PubSub.subscribe(store.changes);
      return Stream.concat(
        Stream.fromEffect(store.counts),
        Stream.fromSubscription(changes).pipe(
          Stream.debounce(WATCH_SETTLE),
          Stream.mapEffect(() => store.counts),
        ),
        // Most changes move no count, and a badge has no use for hearing of those.
      ).pipe(Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)));
    }),
  );

  const signal: Workflows["Service"]["signal"] = Effect.fn("Workflows.signal")(
    function* (address, value, options) {
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
    },
  );
  /** Tell the run that invoked this one, if one did, how it ended. */
  const ended = Effect.fn("WorkflowEngine.ended")(function* (runId: string) {
    const row = yield* store.run(runId);
    if (row === undefined || row.parent_run_id === null || row.parent_wait === null) return;
    if (row.status !== "completed" && row.status !== "stopped" && row.status !== "cancelled") {
      return;
    }
    yield* signal(
      { runId: row.parent_run_id, wait: row.parent_wait },
      {
        outcome: row.status,
        value: row.result_json === null ? null : WorkflowStore.jsonValue(row.result_json),
        ...(row.detail === null ? {} : { reason: row.detail }),
      },
      { id: `${runId}/ended` },
    ).pipe(Effect.ignore);
  });

  const cancel: Workflows["Service"]["cancel"] = Effect.fn("Workflows.cancel")(
    function* (runId, reason) {
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
      yield* store.stepsCancelled(runId);
      // What this run invoked was part of it.
      yield* Effect.forEach(
        yield* store.children(runId),
        (child) => Effect.ignore(cancel(child.run_id, reason)),
        { discard: true },
      );
      yield* ended(runId);
      // Waited for briefly, so the caller usually hears of a run that is cleaned up. A cleanup
      // can take minutes; it goes on by itself, and the sweep finishes one that is cut short.
      const cleanup = yield* Effect.forkIn(endCancelled({ ...row, detail: reason }), scope);
      yield* Fiber.join(cleanup).pipe(Effect.timeoutOption(CANCEL_WAITS));
    },
  );

  // Steps were registered before this engine existed; now they can reach it.
  link.current = { signal, start, ended };

  return Workflows.of({
    start,
    hooks: Effect.succeed(hooks.map(({ workflow, name, path }) => ({ workflow, name, path }))),
    deliver,
    signal,
    resume,
    cancel,
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
          environmentId: step.environment_id,
          result: step.result_json === null ? null : WorkflowStore.jsonValue(step.result_json),
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
    counts,
    stored: Effect.fn("Workflows.stored")(function* (prefix) {
      return (yield* keyValues.list(prefix)).map((row) => ({
        key: row.key,
        value: WorkflowStore.jsonValue(row.valueJson),
      }));
    }),
    storeSet: Effect.fn("Workflows.storeSet")(function* (key, value) {
      yield* keyValues.set(key, WorkflowStore.jsonText(value));
    }),
    storeDelete: Effect.fn("Workflows.storeDelete")(function* (key) {
      yield* keyValues.delete(key);
    }),
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
    Layer.provide(Layer.merge(layerKeyValues, layerEngineLink)),
    Layer.provide(ClusterWorkflowEngine.layer),
    Layer.provide(SingleRunner.layer({ runnerStorage: "sql" })),
    Layer.provide(Layer.succeed(SqlClient.SafeIntegers, true)),
  );
};

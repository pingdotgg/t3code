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
import { DurableDeferred, WorkflowEngine } from "effect/workflow";

import { checkOutput, rejectionText } from "../orchestration-v2/runOutput.ts";
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
  type Issue,
  isSettled,
  type PullRequest,
  type PullRequestAddress,
  type PullRequestWatch,
  standingOf,
  unavailable,
  WorkflowForge,
} from "./WorkflowForge.ts";
import {
  HOOK_PREFIX,
  WorkflowInputError,
  WorkflowNotRegisteredError,
  WorkflowRunNotFoundError,
  Workflows,
} from "./Workflows.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

const SWEEP_EVERY = Duration.seconds(15);
const LOOK_EVERY = Duration.minutes(1);
const LOOK_AT_MOST = 100;
const DEFAULT_SIGNAL_TTL = Duration.days(7);
const RESUME_LOOK_EVERY = Duration.millis(25);
const RESUME_LOOKS = 80;
const WATCH_SETTLE = Duration.millis(100);
const END_TRIES = 5;
// How long a cancelled run's cleanup rests after each failed try before the sweep tries again.
const END_AFTER = ["5 minutes", "20 minutes", "80 minutes", "5 hours"] as const;
// Delivery ids that common senders put on a request and keep when they send it again.
const DELIVERY_HEADERS = [
  "x-github-delivery",
  "x-gitea-delivery",
  "x-gitlab-event-uuid",
  "linear-delivery",
  "webhook-id",
  "idempotency-key",
];
const CANCEL_WAITS = Duration.seconds(30);
// Times of day are the server's own, as they are for scheduled tasks.
const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

const make = Effect.fn("WorkflowEngine.make")(function* (
  registered: ReadonlyArray<readonly [WorkflowDefinition, EngineWorkflow]>,
) {
  const store = yield* WorkflowStore.WorkflowStore;
  const keyValues = yield* KeyValues;
  const link = yield* EngineLink;
  const trackers = Option.getOrElse(yield* Effect.serviceOption(WorkflowForge), () => unavailable);
  // The engine reads its own tables as BigInts. The rest of the server's queries must not.
  const plain =
    <Args extends ReadonlyArray<unknown>, A, E>(call: (...args: Args) => Effect.Effect<A, E>) =>
    (...args: Args) =>
      call(...args).pipe(Effect.provideService(SqlClient.SafeIntegers, false));
  const forge = WorkflowForge.of({
    issues: {
      list: plain(trackers.issues.list),
      read: plain(trackers.issues.read),
      comment: plain(trackers.issues.comment),
      setState: plain(trackers.issues.setState),
      create: plain(trackers.issues.create),
    },
    pullRequests: {
      list: plain(trackers.pullRequests.list),
      read: plain(trackers.pullRequests.read),
      comment: plain(trackers.pullRequests.comment),
      act: plain(trackers.pullRequests.act),
    },
  });
  const scope = yield* Scope.Scope;
  const agents = yield* WorkflowAgents;
  const stopTurn = plain(agents.interrupt);
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

  /** When the sweep resumes a paused run; undefined once it has used up its tries. */
  const resumesAt = (row: WorkflowStore.RunRow) => {
    if (row.status !== "paused" || Number(row.held) === 1) return undefined;
    const rest = definitionByTag.get(row.engine_tag)?.resumeAfter[Number(row.pauses) - 1];
    return rest === undefined
      ? undefined
      : DateTime.addDuration(DateTime.makeUnsafe(row.updated_at), Duration.fromInputUnsafe(rest));
  };
  const toRun = (row: WorkflowStore.RunRow): WorkflowStore.WorkflowRun => {
    const resumes = resumesAt(row);
    return toRunAt(row, resumes === undefined ? null : DateTime.formatIso(resumes));
  };
  const toRunAt = (
    row: WorkflowStore.RunRow,
    resumes: string | null,
  ): WorkflowStore.WorkflowRun => ({
    runId: row.run_id,
    workflow: row.workflow,
    version: Number(row.version),
    title: row.title,
    status: row.status,
    detail: row.detail,
    result: row.result_json === null ? null : WorkflowStore.jsonValue(row.result_json),
    pauses: Number(row.pauses),
    retired: row.ended_at === null && !byTag.has(row.engine_tag),
    resumesAt: resumes,
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
      // A parent written against one version of a child must not get another one's payload.
      const found =
        options.version === undefined
          ? latest(name)
          : registered.find(
              ([candidate]) => candidate.name === name && candidate.version === options.version,
            );
      if (found === undefined) {
        return yield* new WorkflowNotRegisteredError({
          workflow: name,
          ...(options.version === undefined ? {} : { version: options.version }),
        });
      }
      const [definition, engine] = found;
      // A key is one run of the workflow: the engine's own id also counts the version, so a
      // start after a new version would otherwise begin the same work again.
      const other = Effect.fnUntraced(function* (earlier: WorkflowStore.RunRow) {
        if (
          options.parent !== undefined &&
          (earlier.parent_run_id !== options.parent.runId ||
            earlier.parent_wait !== options.parent.wait)
        ) {
          return yield* new WorkflowInputError({
            problem: `Run ${earlier.run_id} of ${name} was started by something else under this key, so it cannot be invoked. Give the invoke a key of its own.`,
          });
        }
        // A start cut off between its row and the engine left a run nothing executes. Executing
        // one the engine has is a no-op.
        const its = byTag.get(earlier.engine_tag);
        if (earlier.ended_at === null && its !== undefined && earlier.input_json !== null) {
          yield* withEngine(
            its.execute(
              {
                idempotencyKey: earlier.idempotency_key,
                input: WorkflowStore.jsonValue(earlier.input_json),
              },
              { discard: true },
            ),
          );
        }
        return { runId: earlier.run_id };
      });
      const earlier = yield* store.runByKey(name, options.idempotencyKey);
      if (earlier !== undefined && earlier.engine_tag !== engineTag(definition)) {
        return yield* other(earlier);
      }
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
      // The row is written first, with who waits for it: the run's own first step writes the same
      // row without that, and whichever write lands first is the one that stays.
      const runId = yield* engine.executionId(payload);
      yield* store.runStarted({
        runId,
        workflow: definition.name,
        version: definition.version,
        engineTag: engineTag(definition),
        idempotencyKey: options.idempotencyKey,
        input: payload.input,
        parent: options.parent,
      });
      // The key is unique, so the row holding it is the run, even one another version started.
      const holder = yield* store.runByKey(name, options.idempotencyKey);
      if (holder !== undefined && holder.run_id !== runId) return yield* other(holder);
      yield* withEngine(engine.execute(payload, { discard: true }));
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
            const started = yield* start(
              definition.name,
              { scheduledAt: due },
              { idempotencyKey: `trigger:${id}:${due}` },
            ).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.as(
                  Effect.logWarning("A scheduled workflow run did not start", {
                    trigger: id,
                    error,
                  }),
                  false,
                ),
              ),
            );
            // Not moved past a time it has not started: the next sweep tries that one again.
            if (!started) continue;
          }
        }
        const next = nextScheduledRunAt(trigger.schedule, now);
        if (next !== null) {
          yield* store.triggerSet(id, DateTime.formatIso(DateTime.toUtc(next)));
        }
      }
    }
  }).pipe(Effect.withSpan("Workflows.fireSchedules"));

  // Trackers and hosts count requests, and nothing here is in that much of a hurry.
  const lookedAt = new Map<string, number>();
  // Said once per engine: the same item is in every look until newer ones push it out.
  const turnedDown = new Set<string>();
  const millisOf = (at: string) =>
    Option.match(DateTime.make(at), { onNone: () => undefined, onSome: DateTime.toEpochMillis });
  /**
   * Start a run for each issue or pull request opened since the trigger last looked. The first
   * look only notes the time, so a workflow never starts on everything that was already there.
   */
  const fireOpened = Effect.gen(function* () {
    const now = yield* DateTime.now;
    for (const definition of latestDefinitions) {
      for (const trigger of definition.triggers) {
        if (trigger.kind !== "issues" && trigger.kind !== "pullRequests") continue;
        const id = `${definition.name}/${trigger.id}`;
        const since = yield* store.triggerNext(id);
        if (since === undefined) {
          yield* store.triggerSet(id, DateTime.formatIso(now));
          continue;
        }
        const last = lookedAt.get(id);
        const at = DateTime.toEpochMillis(now);
        if (last !== undefined && at - last < Duration.toMillis(LOOK_EVERY)) continue;
        lookedAt.set(id, at);
        const found =
          trigger.kind === "issues"
            ? forge.issues.list({
                project: trigger.project,
                // Closed ones too: an item can open and close between two looks.
                state: "all",
                sort: "created",
                limit: LOOK_AT_MOST,
                labels: trigger.labels,
                query: trigger.query,
              })
            : forge.pullRequests.list({
                project: trigger.project,
                state: "all",
                limit: LOOK_AT_MOST,
                query: trigger.query,
              });
        const sinceMillis = millisOf(since) ?? at;
        yield* found.pipe(
          Effect.flatMap(
            Effect.fnUntraced(function* (entries: ReadonlyArray<Issue | PullRequest>) {
              // From the mark on, not after it: two items can share a moment. As times, since a
              // host writes them in its own format and the mark is ours.
              const fresh = entries
                .flatMap((entry) => {
                  const created = millisOf(entry.createdAt);
                  return created === undefined || created < sinceMillis ? [] : [{ entry, created }];
                })
                .toSorted((a, b) => a.created - b.created);
              if (entries.length >= LOOK_AT_MOST && fresh.length === entries.length) {
                yield* Effect.logWarning(
                  "More new items than one look reads; older ones among them start no run",
                  { trigger: id, read: entries.length },
                );
              }
              for (const { entry, created } of fresh) {
                // The key is the address, so an issue seen twice is still one run. One the
                // workflow turns down is passed over, so it does not hold back the ones after it.
                const key = `trigger:${id}:${entry.url}`;
                if (
                  !turnedDown.has(key) &&
                  (yield* store.runByKey(definition.name, key)) === undefined
                ) {
                  yield* start(definition.name, entry, { idempotencyKey: key }).pipe(
                    Effect.catchTags({
                      WorkflowInputError: (error) =>
                        Effect.andThen(
                          Effect.sync(() => turnedDown.add(key)),
                          Effect.logWarning("A workflow turned down an item it was started on", {
                            trigger: id,
                            item: entry.url,
                            error,
                          }),
                        ),
                    }),
                  );
                }
                yield* store.triggerSet(id, DateTime.formatIso(DateTime.makeUnsafe(created)));
              }
            }),
          ),
          Effect.catch((error) =>
            Effect.logWarning("A workflow could not look for new work", { trigger: id, error }),
          ),
        );
      }
    }
  }).pipe(Effect.withSpan("Workflows.fireOpened"));

  const noChecksSince = new Map<string, number>();
  /** End each wait on a pull request that has got where the wait wanted it. */
  const fireWatches = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const wait of yield* store.watches) {
      const id = `watch:${wait.run_id}/${wait.name}`;
      const last = lookedAt.get(id);
      if (last !== undefined && now - last < Duration.toMillis(LOOK_EVERY)) continue;
      lookedAt.set(id, now);
      const watch = WorkflowStore.jsonValue(
        wait.watch_json ?? "null",
      ) as unknown as PullRequestWatch;
      yield* forge.pullRequests.read(watch.pullRequest as PullRequestAddress).pipe(
        Effect.flatMap(
          Effect.fnUntraced(function* (detail) {
            const standing = standingOf(detail);
            // How long the host has listed no checks, not how long the wait is open: a push can
            // clear the list for a moment in the middle of a long wait.
            if (standing.checks !== "none") noChecksSince.delete(id);
            else if (!noChecksSince.has(id)) noChecksSince.set(id, now);
            const without = now - (noChecksSince.get(id) ?? now);
            if (!isSettled(watch.until, standing, without)) return;
            const woke = { expired: false, value: standing };
            if (!(yield* store.waitSignalled(wait.run_id, wait.name, woke))) return;
            lookedAt.delete(id);
            noChecksSince.delete(id);
            yield* wake(wait, woke);
          }),
        ),
        // The wait's own timeout is what ends a wait on something that cannot be read.
        Effect.catch((error) =>
          Effect.logWarning("A workflow could not look at a pull request", { wait: id, error }),
        ),
      );
    }
  }).pipe(Effect.withSpan("Workflows.fireWatches"));

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
      const authored = yield* Effect.try({
        try: () => hook.trigger.key?.(delivery.request),
        catch: (error) =>
          new WorkflowInputError({
            problem: `The key of hook ${hook.name} could not be read from the request: ${text(error)}`,
          }),
      });
      // A sender's own delivery id is kept on its retry, so the retry is the same run.
      const sent = DELIVERY_HEADERS.find((header) => delivery.request.headers[header]);
      const key =
        authored ??
        (sent === undefined ? undefined : `${sent}:${delivery.request.headers[sent]}`) ??
        delivery.deliveryId ??
        (yield* random.uuidV4());
      return Option.some(
        yield* start(hook.workflow, delivery.request, {
          idempotencyKey: `hook:${hook.hookId}:${key}`,
        }),
      );
    },
  );

  // Runs being resumed now: until the engine has them, the sweep must not take them for paused.
  const resuming = new Set<string>();
  /** With `pause`, the sweep's own resume, which only resumes that pause and not a later one. */
  const resumeRun = Effect.fn("WorkflowEngine.resumeRun")(function* (
    runId: string,
    pause?: WorkflowStore.RunRow,
  ) {
    const row = yield* requireRun(runId);
    const engine = byTag.get(row.engine_tag);
    if (engine === undefined) {
      return yield* new WorkflowNotRegisteredError({ workflow: row.engine_tag });
    }
    if (row.ended_at !== null) return;
    resuming.add(runId);
    yield* Effect.gen(function* () {
      // Marked first: once the engine is resumed, the step may fail again and pause the run, and
      // that must be the last word. A crash in between leaves `running`, which the sweep corrects.
      if (row.status === "paused") {
        const unpaused = yield* store.runUnpaused(
          runId,
          pause === undefined
            ? undefined
            : { pauses: Number(pause.pauses), updatedAt: pause.updated_at },
        );
        if (!unpaused && pause !== undefined) return;
      }
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
      yield* store.runUnheld(runId);
    }).pipe(Effect.ensuring(Effect.sync(() => resuming.delete(runId))));
  });
  const resume: Workflows["Service"]["resume"] = (runId) => resumeRun(runId);

  /** A run the engine holds as failed while its row says it goes on: paused, after all. */
  const reconcile = Effect.fn("WorkflowEngine.reconcile")(function* (row: WorkflowStore.RunRow) {
    if (resuming.has(row.run_id)) return;
    const engine = byTag.get(row.engine_tag);
    if (engine === undefined) return;
    const result = yield* withEngine(engine.poll(row.run_id));
    if (Option.isNone(result) || result.value._tag !== "Suspended") return;
    if (result.value.failed !== true) return;
    const cause = result.value.cause;
    // Held as it was: a run that waited for a person still does.
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
    // A step still running would race the cleanup: a machine deleted before it is made.
    yield* link.inFlight.settled(row.run_id);
    // The body may have run its own `onEnd` just as the run was cancelled: once is enough.
    const steps = yield* store.steps(row.run_id);
    if (steps.some((step) => step.name === END_STEP && step.status === "completed")) {
      ending.delete(row.run_id);
      return;
    }
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
      Effect.provideContext(forStep(keyValues, link, forge, row.run_id, END_STEP)),
      // The sweep that runs it reads the engine's BigInts; the cleanup's own code must not.
      Effect.provideService(SqlClient.SafeIntegers, false),
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
      const woke = { expired: true, value: null };
      if (yield* store.waitSignalled(wait.run_id, wait.name, woke)) yield* wake(wait, woke);
    }
    // A claim whose wake a crash swallowed: the wake is made again. Waking twice is harmless.
    for (const wait of yield* store.waitsToWake) {
      if (wait.woke_json === null) continue;
      yield* wake(wait, WorkflowStore.jsonValue(wait.woke_json) as typeof Woke.Type);
    }
    // A cancel that was cut short before it reached what the run had invoked.
    for (const child of yield* store.orphans) {
      yield* Effect.ignore(cancel(child.run_id, "the run that invoked it was cancelled"));
    }
    // A cancel cut short after the run was ended: what it had not stopped yet is stopped here.
    for (const row of yield* store.cancelsCutShort(END_STEP)) {
      if (cancelling.has(row.run_id) || ending.has(row.run_id)) continue;
      const engine = byTag.get(row.engine_tag);
      if (engine !== undefined) yield* withEngine(engine.interrupt(row.run_id));
      yield* stopSteps(row.run_id, yield* store.runningThreads(row.run_id));
    }
    // A run that ended without its parent hearing of it. Telling twice is harmless.
    for (const child of yield* store.untold) yield* ended(child.run_id);
    yield* store.mailExpire;
    yield* fireSchedules;
    yield* fireOpened;
    yield* fireWatches;
    const at = yield* DateTime.now;
    // A run with a step still going is ended by its cancel, which waits for that step.
    for (const row of yield* store.runsToEnd(END_STEP, END_TRIES)) {
      const rest = END_AFTER[Number(row.end_attempts ?? 0) - 1];
      if (row.end_ended_at !== null && rest !== undefined) {
        const due = DateTime.addDuration(
          DateTime.makeUnsafe(row.end_ended_at),
          Duration.fromInputUnsafe(rest),
        );
        if (DateTime.isLessThan(at, due)) continue;
      }
      if (!link.inFlight.busy(row.run_id)) yield* endCancelled(row);
    }
    for (const row of yield* store.everyRun("running")) yield* reconcile(row);
    for (const row of yield* store.everyRun("waiting")) yield* reconcile(row);
    for (const row of yield* store.everyRun("paused")) {
      const due = resumesAt(row);
      if (due === undefined || DateTime.isLessThan(at, due)) continue;
      yield* Effect.ignore(resumeRun(row.run_id, row));
    }
  }).pipe(Effect.withSpan("Workflows.sweep"));

  // With nothing registered there is nothing to resume, end or start: only history to read.
  if (registered.length > 0) {
    yield* sweep.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Workflow sweep failed", cause)),
      Effect.andThen(Effect.sleep(SWEEP_EVERY)),
      Effect.forever,
      Effect.forkScoped,
    );
  }

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
    if (trigger.kind !== "schedule") {
      return `new ${trigger.kind === "issues" ? "issues" : "pull requests"} in ${trigger.project}`;
    }
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
      const woke = { expired: false, value };
      // One signal per wait: a wait another signal took first sends this one to the next.
      while (true) {
        const wait = yield* store.waitAt(address);
        if (wait === undefined) break;
        const schema = WorkflowStore.jsonValue(wait.schema_json) as Record<string, Schema.Json>;
        const checked = yield* checkOutput(schema, valueJson);
        if (Result.isFailure(checked)) {
          return yield* new WorkflowInputError({
            problem: `The value does not fit what ${wait.name} waits for. ${rejectionText(checked.failure)}`,
          });
        }
        if (yield* store.waitSignalled(wait.run_id, wait.name, woke, options.id)) {
          yield* wake(wait, woke);
          return "delivered" as const;
        }
        // Refused for its id: the same signal, sent again at once, woke a wait.
        if (yield* store.signalSeen(options.id)) return "delivered" as const;
      }
      const expiresAt = DateTime.formatIso(
        DateTime.addDuration(
          yield* DateTime.now,
          Duration.fromInputUnsafe(options.ttl ?? DEFAULT_SIGNAL_TTL),
        ),
      );
      if (yield* store.signalSeen(options.id)) return "delivered" as const;
      yield* store.mailPut({ signalId: options.id, address, valueJson, expiresAt });
      // The wait may have opened and looked for mail between the look above and this write.
      while (true) {
        const late = yield* store.waitAt(address);
        if (late === undefined) return "buffered" as const;
        const schema = WorkflowStore.jsonValue(late.schema_json) as Record<string, Schema.Json>;
        // Kept for a wait it fits; this one, the oldest on the channel, is not it.
        if (Result.isFailure(yield* checkOutput(schema, valueJson))) return "buffered" as const;
        const outcome = yield* store.mailDeliver(options.id, late.run_id, late.name, woke);
        if (outcome === "delivered") {
          yield* wake(late, woke);
          return "delivered" as const;
        }
        // The kept copy went to a wait that opened, or was dropped as already delivered.
        if (outcome === "gone") return "delivered" as const;
      }
    },
  );
  const signalAll = Effect.fn("WorkflowEngine.signalAll")(function* (
    address: { readonly channel: string; readonly workflow?: string | undefined },
    value: Schema.Json,
  ) {
    const valueJson = WorkflowStore.jsonText(value);
    let woken = 0;
    for (const wait of yield* store.waitsOn(address.channel, address.workflow)) {
      const schema = WorkflowStore.jsonValue(wait.schema_json) as Record<string, Schema.Json>;
      // A wait this value does not fit was not waiting for it; the others are still woken.
      if (Result.isFailure(yield* checkOutput(schema, valueJson))) continue;
      const woke = { expired: false, value };
      if (!(yield* store.waitSignalled(wait.run_id, wait.name, woke))) continue;
      yield* wake(wait, woke);
      woken++;
    }
    return woken;
  });
  /** Tell the run that invoked this one, if one did, how it ended. */
  const ended = Effect.fn("WorkflowEngine.ended")(function* (runId: string) {
    const row = yield* store.run(runId);
    if (row === undefined || row.parent_run_id === null || row.parent_wait === null) return;
    if (row.ended_at === null) return;
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

  /** A step in flight cannot be interrupted, so the agent it waits on is stopped instead. */
  const stopSteps = Effect.fn("WorkflowEngine.stopSteps")(function* (
    runId: string,
    threads: ReadonlyArray<Parameters<typeof stopTurn>[0]>,
  ) {
    yield* Effect.forEach(threads, (thread) => Effect.ignore(stopTurn(thread)), {
      discard: true,
    });
    yield* store.stepsCancelled(runId, END_STEP);
  });

  // Cancels under way, whose slow part the sweep must not take for one cut short.
  const cancelling = new Set<string>();
  const cancel: Workflows["Service"]["cancel"] = Effect.fn("Workflows.cancel")(
    function* (runId, reason) {
      const row = yield* requireRun(runId);
      if (row.ended_at !== null) return;
      const threads = yield* store.runningThreads(runId);
      const engine = byTag.get(row.engine_tag);
      cancelling.add(runId);
      yield* Effect.gen(function* () {
        // Ended first, so nothing the run still does can be recorded as its outcome. A run that
        // finished in the meantime keeps its own ending, and its cleanup is its own. Not cut off
        // midway: the engine would go on with a cancelled run, or its parent wait forever.
        const cancelled = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (!(yield* store.runEnded(runId, "cancelled", reason, null))) return false;
            if (engine !== undefined) yield* withEngine(engine.interrupt(runId));
            yield* ended(runId);
            return true;
          }),
        );
        if (!cancelled) return;
        yield* stopSteps(runId, threads);
        // What this run invoked was part of it.
        yield* Effect.forEach(
          yield* store.children(runId),
          (child) => Effect.ignore(cancel(child.run_id, reason)),
          { discard: true },
        );
        // Waited for briefly, so the caller usually hears of a run that is cleaned up. A cleanup
        // can take minutes; it goes on by itself, and the sweep finishes one that is cut short.
        const cleanup = yield* Effect.forkIn(endCancelled({ ...row, detail: reason }), scope);
        yield* Fiber.join(cleanup).pipe(Effect.timeoutOption(CANCEL_WAITS));
      }).pipe(Effect.ensuring(Effect.sync(() => cancelling.delete(runId))));
    },
  );

  // Steps were registered before this engine existed; now they can reach it.
  link.current = {
    signal,
    signalAll,
    start,
    ended,
    cancel: (runId, reason) => cancel(runId, reason),
    list: Effect.fn("WorkflowEngine.list")(function* (filter) {
      return (yield* store.runsWhere(filter)).map((row) => ({
        id: row.run_id,
        workflow: row.workflow,
        key: row.idempotency_key,
        title: row.title,
        status: row.status,
        detail: row.detail,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      }));
    }),
  };

  return Workflows.of({
    start,
    hooks: Effect.succeed(hooks.map(({ workflow, name, path }) => ({ workflow, name, path }))),
    // A cancelled run whose cleanup has not worked yet still needs its version to run it.
    unfinished: Effect.map(
      Effect.all([store.unfinished, store.runsToEnd(END_STEP, END_TRIES)]),
      ([open, ending]) => [
        ...open,
        ...ending
          .filter((row) => definitionByTag.get(row.engine_tag)?.onEnd !== undefined)
          .map((row) => ({ workflow: row.workflow, version: Number(row.version) })),
      ],
    ),
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
          said: step.said,
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
export const layer = (
  definitions: ReadonlyArray<WorkflowDefinition>,
  store: typeof WorkflowStore.layer = WorkflowStore.layer,
) => {
  const registered = definitions.map(
    (definition) => [definition, engineWorkflow(definition)] as const,
  );
  const layerDefinitions = Layer.mergeAll(
    Layer.empty,
    ...registered.map(([definition, engine]) => layerDefinition(definition, engine)),
  );
  return Layer.effect(Workflows, make(registered)).pipe(
    Layer.provide(layerDefinitions),
    Layer.provide(store),
    Layer.provide(Layer.merge(layerKeyValues, layerEngineLink)),
    Layer.provide(
      registered.length === 0
        ? WorkflowEngine.layerMemory
        : ClusterWorkflowEngine.layer.pipe(
            Layer.provide(SingleRunner.layer({ runnerStorage: "sql" })),
          ),
    ),
    Layer.provide(Layer.succeed(SqlClient.SafeIntegers, true)),
  );
};

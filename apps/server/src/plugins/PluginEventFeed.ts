/**
 * Delivers the curated event projection (contracts `PluginEvent`) to every
 * enabled plugin that declares the `events` capability.
 *
 * Each such installation has a durable cursor: the event log sequence it has
 * acknowledged through. Its worker reads the log after the cursor in bounded
 * windows and pages, calls the plugin's `t3.events` handler through the
 * catalogue, and moves the cursor past a page only after the plugin answered
 * it. A failed page is retried with backoff and, after `maxFailures`
 * consecutive failures, the worker is quarantined with the cursor unchanged
 * until `plugins.resume`, a re-enable, or a server restart. Delivery is
 * at-least-once. Each worker reports its state through `PluginEventDelivery`,
 * which the catalogue shows as the installation's `eventDelivery`.
 *
 * The cursor starts at the end of the log when an installation is first
 * enabled (the catalogue records it with the enable, through
 * `PluginEventDelivery`), so a new plugin sees exactly the later events. It
 * belongs to the installation: disable and re-enable, consent to changed
 * bytes, and restarts continue from it; remove forgets it. Workers never
 * subscribe to raw events: a commit of a projected event type only wakes
 * them, and they read the store.
 */
import {
  OrchestrationV2RunFinalizationFailed,
  OrchestrationV2RunFinalized,
  PLUGIN_EVENT_THREAD_TITLE_MAX_LENGTH,
  PLUGIN_EVENT_TYPES,
  PLUGIN_EVENTS_CAPABILITY,
  PluginEvent,
  PluginEventPage,
  type EnvironmentId,
  type PluginInstallation,
  type PluginRunFinalizationFailedEvent,
  type PluginRunFinalizedEvent,
  type PluginInstallationId,
  EventId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { EventSinkV2, type EventSinkV2Error } from "../orchestration-v2/EventSink.ts";
import { LiveStreamBufferError } from "../orchestration-v2/LiveStreamBudget.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { PluginCatalog } from "./PluginCatalog.ts";
import { PluginEventDelivery } from "./PluginEventDelivery.ts";
import { PLUGIN_EVENTS_HANDLER } from "./pluginIpcFraming.ts";

export interface PluginEventFeedOptions {
  /** Most events in one page; at most what `PluginEventPage` accepts. */
  readonly pageSize: number;
  /** Most log sequences one read scans, so a far-behind cursor never scans the whole log at once. */
  readonly scanWindow: number;
  /** How long the plugin may take to answer one page. */
  readonly deliveryTimeout: Duration.Input;
  readonly retryBackoff: Duration.Input;
  readonly maxRetryBackoff: Duration.Input;
  /** Consecutive failed attempts at one page before the worker is quarantined. */
  readonly maxFailures: number;
}

const defaultOptions: PluginEventFeedOptions = {
  pageSize: 32,
  scanWindow: 4096,
  deliveryTimeout: Duration.seconds(30),
  retryBackoff: Duration.seconds(2),
  maxRetryBackoff: Duration.minutes(1),
  maxFailures: 5,
};

/** What one installation's worker is doing. Kept in memory; only the cursor is durable. */
type PluginEventFeedState =
  | { readonly _tag: "waiting" }
  | { readonly _tag: "delivering" }
  | {
      readonly _tag: "retrying";
      readonly failures: number;
      readonly reason: string;
      readonly retryAt: string;
    }
  /** `failures` is 0 when delivery stopped in front of an event it cannot read. */
  | { readonly _tag: "quarantined"; readonly failures: number; readonly reason: string }
  /** The registration it delivered to is gone; the next catalogue change replaces it. */
  | { readonly _tag: "stopped" };

interface PluginEventFeedStatus {
  readonly generation: number;
  /** The log sequence acknowledged through, or undefined before it was loaded. */
  readonly cursor: number | undefined;
  readonly state: PluginEventFeedState;
}

/** Milestones a worker reaches, for logs and tests. */
export type PluginEventFeedReceipt =
  | {
      /** A worker loaded its cursor and delivers everything after it. */
      readonly _tag: "Started";
      readonly installationId: PluginInstallationId;
      readonly generation: number;
      readonly cursor: number;
    }
  | {
      readonly _tag: "Acknowledged";
      readonly installationId: PluginInstallationId;
      readonly generation: number;
      /** The new cursor. */
      readonly throughSequence: number;
      /** Events the plugin answered for; 0 when the window held none. */
      readonly delivered: number;
    }
  | {
      readonly _tag: "Failed";
      readonly installationId: PluginInstallationId;
      readonly generation: number;
      readonly cursor: number;
      readonly failures: number;
      readonly reason: string;
    }
  | {
      /** A step outside the plugin failed, such as catalogue storage; retried without counting. */
      readonly _tag: "Retrying";
      readonly installationId: PluginInstallationId;
      readonly generation: number;
      readonly cursor: number;
      readonly reason: string;
    }
  | {
      readonly _tag: "Quarantined";
      readonly installationId: PluginInstallationId;
      readonly generation: number;
      readonly cursor: number;
      readonly failures: number;
      readonly reason: string;
    }
  /** A removed installation's cursor was deleted. */
  | { readonly _tag: "Forgotten"; readonly installationId: PluginInstallationId };

export class PluginEventFeed extends Context.Service<
  PluginEventFeed,
  {
    readonly status: (
      installationId: PluginInstallationId,
    ) => Effect.Effect<Option.Option<PluginEventFeedStatus>>;
    /** Subscribes before returning, so no receipt after this point is missed (sliding, 1024). */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<PluginEventFeedReceipt>,
      never,
      Scope.Scope
    >;
  }
>()("t3/plugins/PluginEventFeed") {}

interface EventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly event_type: string;
  readonly stream_id: string;
  readonly occurred_at: string;
  readonly payload_json: string;
}

interface Worker {
  readonly generation: number;
  cursor: number | undefined;
  state: PluginEventFeedState;
  fiber: Fiber.Fiber<unknown, unknown> | undefined;
}

const decodeFinalized = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunFinalized),
);
const decodeFinalizationFailed = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunFinalizationFailed),
);
const decodeEnvelope = Schema.decodeUnknownEffect(
  Schema.Struct({ event_id: EventId, stream_id: ThreadId }),
);
const checkEvent = Schema.encodeEffect(PluginEvent);
const encodePage = Schema.encodeEffect(PluginEventPage);
const isLiveStreamBufferError = Schema.is(LiveStreamBufferError);

/** Cuts `text` to `max` UTF-16 units without splitting a surrogate pair. */
const truncate = (text: string, max: number) => {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
};

/** True for an installation the feed delivers to: enabled, registered, and asking for events. */
const receivesEvents = (installation: PluginInstallation) =>
  installation.enabled &&
  installation.hostState !== undefined &&
  installation.manifest?.capabilities.includes(PLUGIN_EVENTS_CAPABILITY) === true;

export const make = Effect.fn("PluginEventFeed.make")(function* (
  overrides: Partial<PluginEventFeedOptions> = {},
) {
  const options = { ...defaultOptions, ...overrides };
  const retryBackoff = Duration.fromInputUnsafe(options.retryBackoff);
  const maxRetryBackoff = Duration.fromInputUnsafe(options.maxRetryBackoff);
  const sql = yield* SqlClient.SqlClient;
  const catalog = yield* PluginCatalog;
  const eventSink = yield* EventSinkV2;
  const projections = yield* ProjectionStoreV2;
  const delivery = yield* PluginEventDelivery;
  const environmentId: EnvironmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
  const scope = yield* Effect.scope;

  const workers = new Map<PluginInstallationId, Worker>();
  // Reconciling and resuming both replace workers; one at a time.
  const lock = yield* Semaphore.make(1);
  // A pending wake per worker is enough: the worker reads everything after its cursor.
  const wakes = yield* PubSub.sliding<void>(1);
  const receipts = yield* PubSub.sliding<PluginEventFeedReceipt>(1024);
  const publish = (receipt: PluginEventFeedReceipt) =>
    PubSub.publish(receipts, receipt).pipe(Effect.asVoid);

  const loadCursor = Effect.fnUntraced(function* (installationId: PluginInstallationId) {
    // The catalogue started the cursor when the plugin was enabled; this covers a registration
    // that skipped it.
    yield* delivery.begin(installationId, [PLUGIN_EVENTS_CAPABILITY]);
    const rows = yield* sql<{ readonly acknowledged_sequence: number }>`
      SELECT acknowledged_sequence FROM plugin_event_cursors
      WHERE installation_id = ${installationId}
    `;
    return rows[0]?.acknowledged_sequence ?? (yield* eventSink.latestSequence());
  });

  const saveCursor = Effect.fnUntraced(function* (
    installationId: PluginInstallationId,
    sequence: number,
  ) {
    yield* sql`
      UPDATE plugin_event_cursors
      SET acknowledged_sequence = ${sequence},
          updated_at = ${DateTime.formatIso(yield* DateTime.now)}
      WHERE installation_id = ${installationId}
    `;
  });

  const readRows = (afterSequence: number, throughSequence: number) =>
    sql<EventRow>`
      SELECT sequence, event_id, event_type, stream_id, occurred_at, payload_json
      FROM orchestration_events
      WHERE sequence > ${afterSequence}
        AND sequence <= ${throughSequence}
        AND application_event_version = 2
        AND aggregate_kind = 'thread'
        AND event_type IN ${sql.in(PLUGIN_EVENT_TYPES)}
      ORDER BY sequence ASC
      LIMIT ${options.pageSize}
    `;

  /**
   * Projects one stored row, or returns why it cannot be read. Such a row is
   * never skipped: delivery stops in front of it until someone resumes.
   */
  const project = Effect.fnUntraced(function* (row: EventRow) {
    const decoding: Effect.Effect<
      | Pick<PluginRunFinalizedEvent, "type" | "runId" | "outcome">
      | Pick<PluginRunFinalizationFailedEvent, "type" | "runId" | "operation">,
      Schema.SchemaError
    > =
      row.event_type === "run.finalized"
        ? decodeFinalized(row.payload_json).pipe(
            Effect.map((payload) => ({
              type: "run.finalized" as const,
              runId: payload.runId,
              outcome: payload.outcome,
            })),
          )
        : decodeFinalizationFailed(row.payload_json).pipe(
            Effect.map((payload) => ({
              type: "run.finalization-failed" as const,
              runId: payload.runId,
              operation: payload.operation,
            })),
          );
    const unreadable = {
      unreadable: `The stored event at sequence ${row.sequence} cannot be read.`,
    };
    const decoded = yield* Effect.result(Effect.all([decodeEnvelope(row), decoding]));
    if (Result.isFailure(decoded)) return unreadable;
    const [{ event_id, stream_id }, payload] = decoded.success;
    const shell = yield* projections.getThreadShell(stream_id);
    const event: PluginEvent = {
      deliveryId: event_id,
      sequence: row.sequence,
      occurredAt: row.occurred_at,
      environmentId,
      threadId: stream_id,
      thread:
        shell === null
          ? null
          : {
              projectId: shell.projectId,
              title: truncate(shell.title, PLUGIN_EVENT_THREAD_TITLE_MAX_LENGTH),
            },
      ...payload,
    };
    // Checked here so one bad row quarantines in front of itself instead of failing its page.
    if (Result.isFailure(yield* Effect.result(checkEvent(event)))) return unreadable;
    return { event };
  });

  const backoff = (failures: number) =>
    Duration.min(Duration.times(retryBackoff, 2 ** (failures - 1)), maxRetryBackoff);

  /** Records a worker's state and shows it on its installation; cursor moves change nothing shown. */
  const setState = (
    installationId: PluginInstallationId,
    worker: Worker,
    state: PluginEventFeedState,
  ) =>
    Effect.suspend(() => {
      worker.state = state;
      return delivery.report(
        installationId,
        worker.generation,
        state._tag === "waiting" || state._tag === "delivering"
          ? { _tag: "active" }
          : state._tag === "stopped"
            ? undefined
            : state,
      );
    });

  /** True while the catalogue still shows this registration enabled. */
  const isRegistered = (installationId: PluginInstallationId, generation: number) =>
    catalog.list.pipe(
      Effect.map(({ installations }) =>
        installations.some(
          (installation) =>
            installation.installationId === installationId &&
            installation.generation === generation &&
            receivesEvents(installation),
        ),
      ),
    );

  /** Delivers to one registration until interrupted. */
  const run = (installationId: PluginInstallationId, worker: Worker) => {
    const generation = worker.generation;
    // Consecutive failures at the pending page: the plugin's, and those outside it. They outlive
    // a storage retry, which starts the loop over from the stored cursor.
    let failures = 0;
    let transient = 0;
    /**
     * Every retry path shows `retrying` through here. It stays shown until the pending page is
     * acknowledged, there is nothing left to deliver, or the worker is quarantined.
     */
    const retrying = (attempts: number, reason: string, delay: Duration.Duration) =>
      Effect.flatMap(DateTime.now, (now) =>
        setState(installationId, worker, {
          _tag: "retrying",
          failures: attempts,
          reason,
          retryAt: DateTime.formatIso(DateTime.addDuration(now, delay)),
        }),
      );
    return Effect.gen(function* () {
      const wake = yield* PubSub.subscribe(wakes);
      let cursor = yield* loadCursor(installationId);
      worker.cursor = cursor;
      yield* publish({ _tag: "Started", installationId, generation, cursor });
      /** Stops at the cursor until `resume`, a re-enable, or a restart. */
      const quarantine = (attempts: number, reason: string) =>
        Effect.gen(function* () {
          yield* setState(installationId, worker, {
            _tag: "quarantined",
            failures: attempts,
            reason,
          });
          yield* publish({
            _tag: "Quarantined",
            installationId,
            generation,
            cursor,
            failures: attempts,
            reason,
          });
          return yield* Effect.never;
        });
      while (true) {
        const head = yield* eventSink.latestSequence();
        if (cursor >= head) {
          transient = 0;
          yield* setState(installationId, worker, { _tag: "waiting" });
          yield* PubSub.take(wake);
          continue;
        }
        const through = Math.min(head, cursor + options.scanWindow);
        const rows = yield* readRows(cursor, through);
        const events: Array<PluginEvent> = [];
        let unreadable: { readonly sequence: number; readonly reason: string } | undefined;
        for (const row of rows) {
          const projected = yield* project(row);
          if ("unreadable" in projected) {
            unreadable = { sequence: row.sequence, reason: projected.unreadable };
            break;
          }
          events.push(projected.event);
        }
        // A full page covers the log only up to its last event, and an unreadable one up to
        // just before it.
        const covered =
          unreadable !== undefined
            ? unreadable.sequence - 1
            : rows.length === options.pageSize
              ? (rows.at(-1)?.sequence ?? through)
              : through;
        if (unreadable !== undefined && covered === cursor) {
          yield* Effect.logWarning("Stopped a plugin's event delivery at an unreadable event", {
            installationId,
            sequence: unreadable.sequence,
          });
          return yield* quarantine(0, unreadable.reason);
        }
        if (events.length > 0) {
          if (worker.state._tag !== "retrying")
            yield* setState(installationId, worker, { _tag: "delivering" });
          const input = yield* encodePage({ events }).pipe(Effect.orDie);
          const exit = yield* catalog
            .invoke(installationId, PLUGIN_EVENTS_HANDLER, input, {
              timeout: options.deliveryTimeout,
              generation,
            })
            .pipe(Effect.exit);
          if (exit._tag === "Failure") {
            const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
            if (error?._tag === "PluginCatalogError" || error?._tag === "PluginStoppedError") {
              // Revoked or replaced: this registration is over, and a catalogue change follows.
              if (!(yield* isRegistered(installationId, generation))) {
                yield* setState(installationId, worker, { _tag: "stopped" });
                return yield* Effect.never;
              }
              // Still registered (a storage failure, or a call that raced a management step
              // that changed nothing): not the plugin's failure, so retry without counting it.
              transient++;
              const delay = backoff(transient);
              const reason = error.message.slice(0, 1000);
              yield* retrying(transient, reason, delay);
              yield* publish({ _tag: "Retrying", installationId, generation, cursor, reason });
              yield* Effect.sleep(delay);
              continue;
            }
            if (error === undefined && Cause.hasInterrupts(exit.cause))
              return yield* Effect.failCause(exit.cause);
            // A defect counts like a failed page, so a bug never silently ends delivery.
            failures++;
            const reason = (error?.message ?? Cause.pretty(exit.cause)).slice(0, 1000);
            if (failures >= options.maxFailures) {
              yield* Effect.logWarning("Quarantined a plugin's event delivery", {
                installationId,
                cursor,
                failures,
                reason,
              });
              return yield* quarantine(failures, reason);
            }
            const delay = backoff(failures);
            yield* retrying(failures, reason, delay);
            yield* publish({
              _tag: "Failed",
              installationId,
              generation,
              cursor,
              failures,
              reason,
            });
            yield* Effect.sleep(delay);
            continue;
          }
          failures = 0;
        }
        yield* saveCursor(installationId, covered);
        cursor = covered;
        worker.cursor = cursor;
        transient = 0;
        if (worker.state._tag === "retrying")
          yield* setState(installationId, worker, { _tag: "delivering" });
        yield* publish({
          _tag: "Acknowledged",
          installationId,
          generation,
          throughSequence: covered,
          delivered: events.length,
        });
      }
    }).pipe(
      Effect.scoped,
      // Storage trouble is not the plugin's failure: wait and start over from the stored cursor.
      Effect.tapError((error) =>
        Effect.gen(function* () {
          transient++;
          yield* retrying(
            transient,
            "Could not read or save event delivery progress.",
            maxRetryBackoff,
          );
          yield* Effect.logWarning("Plugin event delivery could not read or save its cursor", {
            installationId,
            error,
          });
        }),
      ),
      Effect.retry(Schedule.spaced(maxRetryBackoff)),
      Effect.asVoid,
    );
  };

  const start = Effect.fnUntraced(function* (
    installationId: PluginInstallationId,
    generation: number,
    cursor: number | undefined,
  ) {
    const worker: Worker = { generation, cursor, state: { _tag: "waiting" }, fiber: undefined };
    workers.set(installationId, worker);
    yield* delivery.report(installationId, generation, { _tag: "active" });
    worker.fiber = yield* run(installationId, worker).pipe(
      Effect.forkIn(scope, { startImmediately: true }),
    );
  });

  const stop = Effect.fnUntraced(function* (installationId: PluginInstallationId) {
    const worker = workers.get(installationId);
    if (worker === undefined) return;
    workers.delete(installationId);
    if (worker.fiber) yield* Fiber.interrupt(worker.fiber);
    yield* delivery.report(installationId, worker.generation, undefined);
  });

  let known: ReadonlySet<PluginInstallationId> | undefined;

  const reconcile = (installations: ReadonlyArray<PluginInstallation>) =>
    lock.withPermit(
      Effect.gen(function* () {
        const wanted = new Map(
          installations
            .filter(receivesEvents)
            .map((installation) => [installation.installationId, installation.generation]),
        );
        for (const [installationId, worker] of workers) {
          if (wanted.get(installationId) !== worker.generation) yield* stop(installationId);
        }
        for (const [installationId, generation] of wanted) {
          if (!workers.has(installationId)) yield* start(installationId, generation, undefined);
        }
        // Removed installations forget their cursor; a later add is a new installation.
        const present = new Set(installations.map((installation) => installation.installationId));
        for (const installationId of known ?? []) {
          if (present.has(installationId)) continue;
          yield* sql`DELETE FROM plugin_event_cursors WHERE installation_id = ${installationId}`.pipe(
            Effect.andThen(publish({ _tag: "Forgotten", installationId })),
            Effect.catch((error) =>
              Effect.logWarning("Could not forget a removed plugin's event cursor", {
                installationId,
                error,
              }),
            ),
          );
        }
        known = present;
      }),
    );

  yield* catalog.subscribe.pipe(
    Stream.runForEach((snapshot) => reconcile(snapshot.installations)),
    Effect.forkScoped,
  );

  // Only commits of projected types wake workers; the events themselves are read from the store.
  // The subscriptions are bounded. One that falls behind fails and is replaced at once: the wake
  // sent before resubscribing makes every worker read what was committed meanwhile.
  const wakeOnCommits = Effect.gen(function* () {
    const head = yield* eventSink.latestSequence();
    yield* PubSub.publish(wakes, undefined);
    yield* Stream.mergeAll(
      PLUGIN_EVENT_TYPES.map((eventType) =>
        eventSink.stream({ eventType, afterSequence: head, bounded: true }),
      ),
      { concurrency: "unbounded" },
    ).pipe(Stream.runForEach(() => PubSub.publish(wakes, undefined)));
  });
  const fellBehind = (error: EventSinkV2Error) =>
    error._tag === "EventSinkStreamError" && isLiveStreamBufferError(error.cause);
  yield* wakeOnCommits.pipe(
    Effect.retry({ while: fellBehind }),
    Effect.tapError((error) => Effect.logWarning("Plugin event wakeups stopped", { error })),
    Effect.retry(Schedule.spaced(maxRetryBackoff)),
    Effect.forkScoped,
  );

  // `plugins.resume` reaches this through the catalogue.
  yield* delivery.handleResume((installationId) =>
    lock.withPermit(
      Effect.suspend(() => {
        const worker = workers.get(installationId);
        if (worker?.state._tag !== "quarantined" && worker?.state._tag !== "retrying")
          return Effect.void;
        return stop(installationId).pipe(
          Effect.andThen(start(installationId, worker.generation, worker.cursor)),
        );
      }),
    ),
  );

  return PluginEventFeed.of({
    status: (installationId) =>
      Effect.sync(() =>
        Option.fromNullishOr(workers.get(installationId)).pipe(
          Option.map(({ generation, cursor, state }) => ({ generation, cursor, state })),
        ),
      ),
    subscribe: PubSub.subscribe(receipts),
  });
});

export const layer = (overrides?: Partial<PluginEventFeedOptions>) =>
  Layer.effect(PluginEventFeed, make(overrides));

/**
 * Tests for the notification transport surface: the `notifications.subscribe`
 * stream and the outcome report-back that completes an outbox row.
 *
 * The reactor is deliberately absent here — its behaviour has its own suite.
 * These tests drive the two seams a transport actually touches: rows already in
 * the outbox (a reconnect gap) and edges published live by the bus.
 *
 * No sleeps and no forked collectors: a bus subscription buffers from the moment
 * `subscribe` returns, so a test can publish first and collect afterwards and
 * still observe exactly what a connected transport would.
 */
import {
  EventId,
  type NotificationDetectionVerdict,
  type NotificationKind,
  type NotificationStreamItem,
  type NotificationTransportOutcome,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { NotificationOutboxRepositoryLive } from "../../persistence/Layers/NotificationOutbox.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  NotificationOutboxRepository,
  type NotificationOutboxRecord,
} from "../../persistence/Services/NotificationOutbox.ts";
import { NotificationEdgeBus } from "../Services/NotificationEdgeBus.ts";
import { NotificationTransport } from "../Services/NotificationTransport.ts";
import { NotificationEdgeBusLive } from "./NotificationEdgeBus.ts";
import { NotificationTransportLive } from "./NotificationTransport.ts";

const PROJECT_ID = ProjectId.make("project-transport");
const THREAD_ID = ThreadId.make("thread-transport");

const testLayer = Layer.empty.pipe(
  Layer.provideMerge(NotificationTransportLive),
  Layer.provideMerge(NotificationEdgeBusLive),
  Layer.provideMerge(NotificationOutboxRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-notification-transport-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

interface RowOverrides {
  readonly kind?: NotificationKind;
  readonly detectionVerdict?: NotificationDetectionVerdict;
  readonly transportOutcome?: NotificationTransportOutcome;
  readonly transportName?: string | null;
  readonly completedAt?: string | null;
}

const makeRow = (sequence: number, overrides?: RowOverrides): NotificationOutboxRecord => {
  const kind = overrides?.kind ?? "turn-completed";
  const turnId = TurnId.make(`turn-${sequence}`);
  return {
    identityKey: `t3:notif:${THREAD_ID}:${kind}:${turnId}`,
    kind,
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    turnId,
    requestId: null,
    projectTitle: "t3",
    threadTitle: "Fix failing CI",
    headline: "Turn complete",
    detail: null,
    triggeringEventId: EventId.make(`event-${sequence}`),
    triggeringSequence: sequence,
    previousPhase: "running",
    nextPhase: "completed",
    detectionVerdict: overrides?.detectionVerdict ?? "detected",
    decidingGuard: "terminal-edge",
    transportOutcome: overrides?.transportOutcome ?? "no-transport-connected",
    transportName: overrides?.transportName ?? null,
    completedAt: overrides?.completedAt ?? null,
    detectedAt: "2026-08-06T00:00:00.000Z",
  };
};

const edgeOf = (row: NotificationOutboxRecord) => ({
  identityKey: row.identityKey,
  kind: row.kind,
  threadId: row.threadId,
  projectId: row.projectId,
  turnId: row.turnId,
  requestId: row.requestId,
  projectTitle: row.projectTitle,
  threadTitle: row.threadTitle,
  headline: row.headline,
  detail: row.detail,
  triggeringEventId: row.triggeringEventId,
  triggeringSequence: row.triggeringSequence,
  previousPhase: row.previousPhase,
  nextPhase: row.nextPhase,
  detectedAt: row.detectedAt,
});

const summarize = (items: ReadonlyArray<NotificationStreamItem>) =>
  items.map((item) => (item.kind === "edge" ? item.edge.triggeringSequence : "synchronized"));

describe("notification subscription", () => {
  it.effect("delivers edges detected while connected, in order", () =>
    Effect.gen(function* () {
      const outbox = yield* NotificationOutboxRepository;
      const transport = yield* NotificationTransport;
      const bus = yield* NotificationEdgeBus;

      // A row that predates the subscription. Without a cursor it must stay
      // invisible: subscribing is not a history replay.
      yield* outbox.insertIfAbsent(makeRow(5));

      const stream = yield* transport.subscribe({});
      yield* bus.publish(edgeOf(makeRow(7)));
      yield* bus.publish(edgeOf(makeRow(8)));

      const items = yield* Stream.runCollect(stream.pipe(Stream.take(2)));

      assert.deepEqual(summarize(items), [7, 8]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resumes from a cursor and does not re-deliver the overlap", () =>
    Effect.gen(function* () {
      const outbox = yield* NotificationOutboxRepository;
      const transport = yield* NotificationTransport;
      const bus = yield* NotificationEdgeBus;

      const alreadySeen = makeRow(5);
      // A row a transport suppressed by policy still replays: policy suppression
      // records a non-delivery, it is never a dedup mechanism.
      const suppressed = makeRow(6, {
        kind: "turn-failed",
        transportOutcome: "suppressed:focused",
        transportName: "desktop",
        completedAt: "2026-08-06T00:00:01.000Z",
      });
      const inTheGap = makeRow(7);
      // Never deliverable: only `detected` rows reach a transport.
      const notAnEdge = makeRow(8, {
        kind: "approval-required",
        detectionVerdict: "baseline",
      });
      yield* outbox.insertIfAbsent(alreadySeen);
      yield* outbox.insertIfAbsent(suppressed);
      yield* outbox.insertIfAbsent(inTheGap);
      yield* outbox.insertIfAbsent(notAnEdge);

      const stream = yield* transport.subscribe({ afterSequence: 5 });
      // The reconnect overlap: the same edge the catch-up read already returned,
      // republished live, plus a genuinely new one.
      yield* bus.publish(edgeOf(inTheGap));
      yield* bus.publish(edgeOf(makeRow(9)));

      const items = yield* Stream.runCollect(stream.pipe(Stream.take(3)));

      assert.deepEqual(summarize(items), [6, 7, 9]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("marks the boundary between catch-up and live on request", () =>
    Effect.gen(function* () {
      const outbox = yield* NotificationOutboxRepository;
      const transport = yield* NotificationTransport;
      const bus = yield* NotificationEdgeBus;

      yield* outbox.insertIfAbsent(makeRow(6));

      const stream = yield* transport.subscribe({
        afterSequence: 5,
        requestCompletionMarker: true,
      });
      yield* bus.publish(edgeOf(makeRow(9)));

      const items = yield* Stream.runCollect(stream.pipe(Stream.take(3)));

      assert.deepEqual(summarize(items), [6, "synchronized", 9]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("notification transport outcome report-back", () => {
  it.effect("completes the row a transport claims", () =>
    Effect.gen(function* () {
      const outbox = yield* NotificationOutboxRepository;
      const transport = yield* NotificationTransport;

      const row = makeRow(7);
      yield* outbox.insertIfAbsent(row);

      const report = yield* transport.reportTransportOutcome({
        identityKey: row.identityKey,
        transportName: "desktop",
        outcome: "shown",
      });

      assert.strictEqual(report.transportOutcome, "shown");
      assert.strictEqual(report.transportName, "desktop");
      assert.isNotNull(report.completedAt);

      const stored = yield* outbox.getByIdentityKey({ identityKey: row.identityKey });
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) {
        assert.strictEqual(stored.value.transportOutcome, "shown");
        assert.strictEqual(stored.value.transportName, "desktop");
        assert.strictEqual(stored.value.completedAt, report.completedAt);
        // Detection is untouched by policy: the row still says a real edge fired.
        assert.strictEqual(stored.value.detectionVerdict, "detected");
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("records a policy suppression as a non-delivery, not as delivered", () =>
    Effect.gen(function* () {
      const outbox = yield* NotificationOutboxRepository;
      const transport = yield* NotificationTransport;

      const row = makeRow(7);
      yield* outbox.insertIfAbsent(row);

      const report = yield* transport.reportTransportOutcome({
        identityKey: row.identityKey,
        transportName: "web",
        outcome: "suppressed:focused",
      });

      assert.strictEqual(report.transportOutcome, "suppressed:focused");

      // Still a decided edge, so a resuming subscriber is still offered it.
      const resumable = yield* outbox.listDecidedEdgesAfterSequence({
        afterSequence: 6,
        limit: 10,
      });
      assert.deepEqual(
        resumable.map((entry) => entry.identityKey),
        [row.identityKey],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("leaves rows no transport claimed as no-transport-connected", () =>
    Effect.gen(function* () {
      const outbox = yield* NotificationOutboxRepository;
      const transport = yield* NotificationTransport;

      const claimed = makeRow(7);
      const unclaimed = makeRow(8, { kind: "turn-failed" });
      yield* outbox.insertIfAbsent(claimed);
      yield* outbox.insertIfAbsent(unclaimed);

      yield* transport.reportTransportOutcome({
        identityKey: claimed.identityKey,
        transportName: "desktop",
        outcome: "shown",
      });

      const stored = yield* outbox.getByIdentityKey({ identityKey: unclaimed.identityKey });
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) {
        assert.strictEqual(stored.value.transportOutcome, "no-transport-connected");
        assert.isNull(stored.value.transportName);
        assert.isNull(stored.value.completedAt);
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps the first transport's outcome and reports it back to the second", () =>
    Effect.gen(function* () {
      const outbox = yield* NotificationOutboxRepository;
      const transport = yield* NotificationTransport;

      const row = makeRow(7);
      yield* outbox.insertIfAbsent(row);

      const first = yield* transport.reportTransportOutcome({
        identityKey: row.identityKey,
        transportName: "desktop",
        outcome: "shown",
      });
      const second = yield* transport.reportTransportOutcome({
        identityKey: row.identityKey,
        transportName: "web",
        outcome: "suppressed:disabled",
      });

      assert.deepEqual(second, first);
      assert.strictEqual(second.transportOutcome, "shown");
      assert.strictEqual(second.transportName, "desktop");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails loudly when a transport reports an edge that was never recorded", () =>
    Effect.gen(function* () {
      const transport = yield* NotificationTransport;

      const error = yield* Effect.flip(
        transport.reportTransportOutcome({
          identityKey: "t3:notif:thread-transport:turn-completed:turn-nope",
          transportName: "desktop",
          outcome: "shown",
        }),
      );

      assert.strictEqual(error._tag, "NotificationReportTransportOutcomeError");
      assert.strictEqual(error.identityKey, "t3:notif:thread-transport:turn-completed:turn-nope");
    }).pipe(Effect.provide(testLayer)),
  );
});

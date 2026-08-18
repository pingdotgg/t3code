/**
 * NotificationTransport layer.
 *
 * @module NotificationTransport
 */
import {
  NOTIFICATION_CATCH_UP_MAX_EDGES,
  NotificationReportTransportOutcomeError,
  type NotificationStreamItem,
  NotificationSubscribeError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  NotificationOutboxRepository,
  notificationDecidedEdgeFromRecord,
} from "../../persistence/Services/NotificationOutbox.ts";
import { NotificationEdgeBus } from "../Services/NotificationEdgeBus.ts";
import {
  NotificationTransport,
  type NotificationTransportShape,
} from "../Services/NotificationTransport.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makeNotificationTransport = Effect.gen(function* () {
  const outbox = yield* NotificationOutboxRepository;
  const edgeBus = yield* NotificationEdgeBus;

  const subscribe: NotificationTransportShape["subscribe"] = Effect.fn("subscribe")(
    function* (input) {
      // Attach the live feed *before* reading the catch-up range: the
      // subscription buffers from this point, so an edge decided while that read
      // is in flight is past the rows it returned and still arrives live.
      const liveEdges = yield* edgeBus.subscribe;

      const afterSequence = input.afterSequence;
      const catchUpItems: Array<NotificationStreamItem> = [];
      // Identity keys the catch-up already delivered, so the overlap between the
      // persisted read and the live buffer is deduped by identity rather than by
      // sequence: one domain event can decide two edges (a completion and an
      // approval), and they share a sequence.
      const deliveredKeys = new Set<string>();
      let dedupUntilSequence = 0;

      if (afterSequence !== undefined) {
        const rows = yield* outbox
          .listDecidedEdgesAfterSequence({
            afterSequence,
            limit: NOTIFICATION_CATCH_UP_MAX_EDGES,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new NotificationSubscribeError({
                  message: `Failed to read decided notification edges after sequence ${afterSequence}`,
                  cause,
                }),
            ),
          );
        for (const row of rows) {
          catchUpItems.push({ kind: "edge", edge: notificationDecidedEdgeFromRecord(row) });
          deliveredKeys.add(row.identityKey);
        }
        const lastRow = rows.at(-1);
        dedupUntilSequence = lastRow === undefined ? afterSequence : lastRow.triggeringSequence;
      }

      const keepItem = (item: NotificationStreamItem): boolean => {
        if (item.kind !== "edge") {
          return true;
        }
        if (item.edge.triggeringSequence > dedupUntilSequence) {
          // Past the catch-up range: the dedup set can never match again.
          deliveredKeys.clear();
          return true;
        }
        return (
          !deliveredKeys.has(item.edge.identityKey) &&
          (afterSequence === undefined || item.edge.triggeringSequence > afterSequence)
        );
      };

      const liveStream = liveEdges.pipe(
        Stream.map((edge): NotificationStreamItem => ({ kind: "edge", edge })),
        Stream.filter(keepItem),
      );
      const afterCatchUp =
        input.requestCompletionMarker === true
          ? Stream.concat(
              Stream.succeed<NotificationStreamItem>({ kind: "synchronized" }),
              liveStream,
            )
          : liveStream;

      return Stream.concat(Stream.fromIterable(catchUpItems), afterCatchUp);
    },
  );

  const reportTransportOutcome: NotificationTransportShape["reportTransportOutcome"] = Effect.fn(
    "reportTransportOutcome",
  )(function* (input) {
    const failed = (message: string) => (cause: unknown) =>
      new NotificationReportTransportOutcomeError({
        message,
        identityKey: input.identityKey,
        cause,
      });

    const completedAt = yield* nowIso;
    yield* outbox
      .completeTransportOutcome({
        identityKey: input.identityKey,
        transportOutcome: input.outcome,
        transportName: input.transportName,
        completedAt,
      })
      .pipe(
        Effect.mapError(failed(`Failed to complete notification outbox row ${input.identityKey}`)),
      );

    const stored = yield* outbox
      .getByIdentityKey({ identityKey: input.identityKey })
      .pipe(Effect.mapError(failed(`Failed to read notification outbox row ${input.identityKey}`)));

    if (Option.isNone(stored)) {
      // A transport can only report an edge it received, so an unknown identity
      // key is a transport bug (or a hand-crafted call) and is worth the noise.
      return yield* new NotificationReportTransportOutcomeError({
        message: `No notification outbox row for identity key ${input.identityKey}`,
        identityKey: input.identityKey,
      });
    }

    const row = stored.value;
    if (row.transportOutcome !== input.outcome || row.transportName !== input.transportName) {
      yield* Effect.logDebug("notification outcome kept the first transport's report", {
        identityKey: row.identityKey,
        reportedBy: input.transportName,
        reportedOutcome: input.outcome,
        storedBy: row.transportName,
        storedOutcome: row.transportOutcome,
      });
    }

    return {
      identityKey: row.identityKey,
      transportOutcome: row.transportOutcome,
      transportName: row.transportName,
      completedAt: row.completedAt,
    };
  });

  return {
    subscribe,
    reportTransportOutcome,
  } satisfies NotificationTransportShape;
});

export const NotificationTransportLive = Layer.effect(
  NotificationTransport,
  makeNotificationTransport,
);

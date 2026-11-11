import * as k2 from "@distilled.cloud/cloudflare/k2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** Test-side helpers shared by the K2 suites. */

class StreamStillExists extends Data.TaggedError("StreamStillExists")<{ streamId: string }> {}

class SubscriptionStillExists extends Data.TaggedError("SubscriptionStillExists")<{
  subscriptionId: string;
}> {}

const gone = Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(15)]);

/** Wait until `getStream` reports `K2StreamNotFound`. */
export const waitForStreamGone = (accountId: string, streamId: string) =>
  k2.getStream({ accountId, streamId }).pipe(
    Effect.flatMap(() => Effect.fail(new StreamStillExists({ streamId }))),
    Effect.retry({ while: (e) => e._tag === "StreamStillExists", schedule: gone }),
    Effect.catchTag("K2StreamNotFound", () => Effect.void),
  );

/** Wait until `getSubscription` reports the subscription (or its stream) gone. */
export const waitForSubscriptionGone = (streamId: string, subscriptionId: string) =>
  k2.getSubscription({ streamId, subscriptionId }).pipe(
    Effect.flatMap(() => Effect.fail(new SubscriptionStillExists({ subscriptionId }))),
    Effect.retry({ while: (e) => e._tag === "SubscriptionStillExists", schedule: gone }),
    Effect.catchTag(["K2SubscriptionNotFound", "K2StreamNotFound"], () => Effect.void),
  );

const decoder = new TextDecoder();

export interface VerifiedRecord {
  text: string;
  headers: Record<string, string>;
}

class NotEnoughRecords extends Data.TaggedError("NotEnoughRecords")<{
  expected: number;
  received: number;
}> {}

/**
 * Out-of-band verification: drain a subscription with distilled `consume`
 * + `ackBatch` until `expected` records were read (bounded to ~60 s).
 */
export const drainSubscription = (
  streamId: string,
  subscriptionId: string,
  expected: number,
  workerId = "alchemy-k2-verifier",
) =>
  Effect.gen(function* () {
    const received: VerifiedRecord[] = [];
    const once = Effect.gen(function* () {
      const batch = yield* k2.consume({ streamId, subscriptionId, workerId, maxRecords: 1000 });
      if (batch.batchId) {
        for (const record of batch.records) {
          received.push({
            text: decoder.decode(Uint8Array.from(atob(record.content), (c) => c.charCodeAt(0))),
            headers: Object.fromEntries(
              Object.entries(record.headers ?? {}).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          });
        }
        yield* k2.ackBatch({ streamId, subscriptionId, batchId: batch.batchId, workerId });
      }
      if (received.length < expected) {
        return yield* Effect.fail(new NotEnoughRecords({ expected, received: received.length }));
      }
    });
    yield* once.pipe(
      Effect.retry({
        while: (e) => e._tag === "NotEnoughRecords" || e._tag === "K2BatchPending",
        schedule: Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(60)]),
      }),
    );
    return received;
  });

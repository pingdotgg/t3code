import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { lt } from "drizzle-orm";

import { RelayDb, type RelayDatabase } from "../db.ts";
import { relayDpopProofs } from "../schema.ts";

export class DpopProofReplayPersistenceError extends Data.TaggedError(
  "DpopProofReplayPersistenceError",
)<{
  readonly cause: unknown;
}> {}

export interface DpopProofReplayShape {
  readonly consume: (input: {
    readonly thumbprint: string;
    readonly jti: string;
    readonly iat: number;
    readonly expiresAt: DateTime.DateTime;
  }) => Effect.Effect<boolean, DpopProofReplayPersistenceError>;
}

export class DpopProofReplay extends Context.Service<DpopProofReplay, DpopProofReplayShape>()(
  "DpopProofReplay",
) {}

export const pruneExpired = Effect.fn("relay.dpop_proofs.prune_expired")(function* (
  db: RelayDatabase,
) {
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* db.delete(relayDpopProofs).where(lt(relayDpopProofs.expiresAt, now));
});

const make = Effect.gen(function* () {
  const db = yield* RelayDb;

  return DpopProofReplay.of({
    consume: (input) =>
      Effect.gen(function* () {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const inserted = yield* db
          .insert(relayDpopProofs)
          .values({
            thumbprint: input.thumbprint,
            jti: input.jti,
            iat: input.iat,
            expiresAt: DateTime.formatIso(input.expiresAt),
            createdAt,
          })
          .onConflictDoNothing()
          .returning({ jti: relayDpopProofs.jti });
        return inserted.length > 0;
      }).pipe(Effect.mapError((cause) => new DpopProofReplayPersistenceError({ cause }))),
  });
});

export const layer = Layer.effect(DpopProofReplay, make);

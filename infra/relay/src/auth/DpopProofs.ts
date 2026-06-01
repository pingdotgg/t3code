import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import { lt } from "drizzle-orm";

import { verifyDpopProof } from "@t3tools/shared/dpop";
import { RelayDb } from "../db.ts";
import { relayDpopProofs } from "../persistence/schema.ts";

export class DpopProofReplayPersistenceError extends Data.TaggedError(
  "DpopProofReplayPersistenceError",
)<{
  readonly cause: unknown;
}> {}

export interface DpopProofReplayShape {
  readonly verifyAndConsume: (input: {
    readonly proof: string | undefined;
    readonly method: string;
    readonly url: string;
    readonly expectedThumbprint?: string;
    readonly expectedAccessToken?: string;
    readonly now: DateTime.DateTime;
  }) => Effect.Effect<string, HttpApiError.Unauthorized | DpopProofReplayPersistenceError>;

  readonly consume: (input: {
    readonly thumbprint: string;
    readonly jti: string;
    readonly iat: number;
    readonly expiresAt: DateTime.DateTime;
  }) => Effect.Effect<boolean, DpopProofReplayPersistenceError>;

  readonly pruneExpired: Effect.Effect<void, DpopProofReplayPersistenceError>;
}

export class DpopProofReplay extends Context.Service<DpopProofReplay, DpopProofReplayShape>()(
  "t3code-relay/auth/DpopProofs/DpopProofReplay",
) {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb;

  const consume: DpopProofReplayShape["consume"] = Effect.fn("relay.dpop_proofs.consume")(
    function* (input) {
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
    },
    Effect.mapError((cause) => new DpopProofReplayPersistenceError({ cause })),
  );

  const verifyAndConsume: DpopProofReplayShape["verifyAndConsume"] = Effect.fn(
    "relay.dpop_proofs.verify_and_consume",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({
      "relay.dpop.method": input.method,
      "relay.dpop.expected_thumbprint_present": input.expectedThumbprint !== undefined,
      "relay.dpop.expected_access_token_present": input.expectedAccessToken !== undefined,
    });
    const result = verifyDpopProof({
      proof: input.proof,
      method: input.method,
      url: input.url,
      nowEpochSeconds: Math.floor(input.now.epochMilliseconds / 1_000),
      ...(input.expectedThumbprint ? { expectedThumbprint: input.expectedThumbprint } : {}),
      ...(input.expectedAccessToken ? { expectedAccessToken: input.expectedAccessToken } : {}),
    });
    if (!result.ok) {
      yield* Effect.logWarning("relay dpop proof rejected", {
        reason: result.reason,
        method: input.method,
        url: input.url,
        expectedThumbprintPresent: input.expectedThumbprint !== undefined,
        expectedAccessTokenPresent: input.expectedAccessToken !== undefined,
      });
      return yield* new HttpApiError.Unauthorized({});
    }
    const consumed = yield* consume({
      thumbprint: result.thumbprint,
      jti: result.jti,
      iat: result.iat,
      expiresAt: DateTime.add(input.now, { minutes: 5 }),
    });
    if (!consumed) {
      yield* Effect.logWarning("relay dpop proof replay rejected", {
        thumbprint: result.thumbprint,
        jti: result.jti,
        iat: result.iat,
      });
      return yield* new HttpApiError.Unauthorized({});
    }
    yield* Effect.annotateCurrentSpan({
      "relay.dpop.thumbprint": result.thumbprint,
      "relay.dpop.iat": result.iat,
    });
    return result.thumbprint;
  });

  const pruneExpired: DpopProofReplayShape["pruneExpired"] = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.annotateCurrentSpan({ "relay.dpop_prune.before": now });
    yield* db.delete(relayDpopProofs).where(lt(relayDpopProofs.expiresAt, now));
  }).pipe(
    Effect.withSpan("relay.dpop_proofs.prune_expired"),
    Effect.mapError((cause) => new DpopProofReplayPersistenceError({ cause })),
  );

  return DpopProofReplay.of({
    verifyAndConsume,
    consume,
    pruneExpired,
  });
});

export const layer = Layer.effect(DpopProofReplay, make);

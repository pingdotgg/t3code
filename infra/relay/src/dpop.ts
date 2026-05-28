import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import * as DpopProofs from "./persistence/DpopProofs.ts";

export function verifyAndConsumeDpopProof(input: {
  readonly proof: string | undefined;
  readonly method: string;
  readonly url: string;
  readonly expectedThumbprint?: string;
  readonly expectedAccessToken?: string;
  readonly now: DateTime.DateTime;
  readonly dpopProofs: DpopProofs.DpopProofReplayShape;
}) {
  return Effect.gen(function* () {
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
    const consumed = yield* input.dpopProofs
      .consume({
        thumbprint: result.thumbprint,
        jti: result.jti,
        iat: result.iat,
        expiresAt: DateTime.add(input.now, { minutes: 5 }),
      })
      .pipe(Effect.mapError(() => new HttpApiError.Unauthorized({})));
    if (!consumed) {
      yield* Effect.logWarning("relay dpop proof replay rejected", {
        thumbprint: result.thumbprint,
        jti: result.jti,
        iat: result.iat,
      });
      return yield* new HttpApiError.Unauthorized({});
    }
    return result.thumbprint;
  });
}

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  apnsProviderTokenCacheKey,
  makeApnsJwt,
  type ApnsJwtError,
  type ApnsJwtSigningInput,
} from "./apnsJwt.ts";

// Reuse JWTs within their 60-minute validity; frequent refreshes trigger APNs TooManyProviderTokenUpdates.
export const APNS_JWT_REUSE_SECONDS = 45 * 60;

export class ApnsProviderTokens extends Context.Service<
  ApnsProviderTokens,
  {
    readonly getJwt: (input: ApnsJwtSigningInput) => Effect.Effect<string, ApnsJwtError>;
  }
>()("t3code-relay/agentActivity/ApnsProviderTokens") {}

interface CachedProviderToken {
  readonly jwt: string;
  readonly issuedAtUnixSeconds: number;
}

// Deterministic signing plus quantized iat gives isolates identical tokens; cache only to avoid repeated signing.
const isolateTokenCache = new Map<string, CachedProviderToken>();

export function __resetApnsProviderTokenCacheForTest(): void {
  isolateTokenCache.clear();
}

function quantizedApnsJwtIssuedAt(nowUnixSeconds: number): number {
  return Math.floor(nowUnixSeconds / APNS_JWT_REUSE_SECONDS) * APNS_JWT_REUSE_SECONDS;
}

const make = () =>
  ApnsProviderTokens.of({
    getJwt: Effect.fnUntraced(function* (input) {
      const issuedAtUnixSeconds = quantizedApnsJwtIssuedAt(input.issuedAtUnixSeconds);
      const cacheKey = apnsProviderTokenCacheKey(input);
      const cached = isolateTokenCache.get(cacheKey);
      if (cached && cached.issuedAtUnixSeconds === issuedAtUnixSeconds) {
        return cached.jwt;
      }
      const jwt = yield* makeApnsJwt({ ...input, issuedAtUnixSeconds });
      isolateTokenCache.set(cacheKey, { jwt, issuedAtUnixSeconds });
      return jwt;
    }),
  });

export const layer = Layer.succeed(ApnsProviderTokens, make());

import type { RuntimeContext } from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { BetterAuthStorageError } from "./Errors.ts";

/**
 * Effect-native contract for Better Auth's `secondaryStorage` — the
 * key-value store used for sessions, rate limiting, and OAuth state when
 * configured.
 *
 * All five operations are required (Better Auth marks `getAndDelete` and
 * `increment` optional today but documents them as required in the next
 * major). TTLs are in SECONDS, matching Better Auth.
 */
export interface SecondaryStorageService {
  readonly get: (
    key: string,
  ) => Effect.Effect<string | null, BetterAuthStorageError, RuntimeContext>;
  readonly set: (
    key: string,
    value: string,
    ttlSeconds?: number,
  ) => Effect.Effect<void, BetterAuthStorageError, RuntimeContext>;
  readonly delete: (
    key: string,
  ) => Effect.Effect<void, BetterAuthStorageError, RuntimeContext>;
  /** Atomic read-and-delete where the backing store supports it. */
  readonly getAndDelete: (
    key: string,
  ) => Effect.Effect<string | null, BetterAuthStorageError, RuntimeContext>;
  /**
   * Increment a counter, creating it at `1` with `ttlSeconds` on first
   * write. Later increments never extend the TTL (fixed window).
   */
  readonly increment: (
    key: string,
    ttlSeconds?: number,
  ) => Effect.Effect<number, BetterAuthStorageError, RuntimeContext>;
}

/**
 * Optional secondary-storage dependency of {@link BetterAuth}.
 *
 * When a layer providing this service is in context, Better Auth is
 * configured with `secondaryStorage` and its rate limiter defaults to it.
 * When absent, Better Auth runs database-only — the dependency is resolved
 * with `Effect.serviceOption`, so it never appears in `BetterAuth`'s
 * requirements.
 *
 * Better Auth's guidance is a Redis-style store: strongly consistent
 * reads and precise sub-minute TTLs. Eventually-consistent stores
 * (e.g. Cloudflare KV) are NOT a fit — session reads race cross-location
 * propagation and rate-limit windows need atomic counters. A strongly
 * consistent Cloudflare option would be a Durable Object-backed layer.
 */
export class SecondaryStorage extends Context.Service<
  SecondaryStorage,
  SecondaryStorageService
>()("BetterAuth.SecondaryStorage") {}

/**
 * Bridge the Effect-native service to the promise interface Better Auth
 * expects, running each operation in the captured runtime context.
 *
 * @internal
 */
export const toPromiseStorage = (
  storage: SecondaryStorageService,
  runPromise: <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) => Promise<A>,
) => ({
  get: (key: string) => runPromise(storage.get(key)),
  set: (key: string, value: string, ttl?: number) =>
    runPromise(storage.set(key, value, ttl)),
  delete: (key: string) => runPromise(storage.delete(key)),
  getAndDelete: (key: string) => runPromise(storage.getAndDelete(key)),
  increment: (key: string, ttl: number) =>
    runPromise(storage.increment(key, ttl)),
});

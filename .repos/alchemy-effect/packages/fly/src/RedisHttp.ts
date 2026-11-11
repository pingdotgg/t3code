/**
 * Shared Redis command-client builders. NOT exported from `index.ts`.
 *
 * The RESP client lives in `@alchemy.run/redis`. These aliases keep the
 * `{Op}Http.ts` layers stable.
 */
// Re-export from the defining module, not the `@alchemy.run/redis` barrel:
// rolldown's lazyBarrel rejects an unused re-export from an `export *` barrel
// (https://github.com/rolldown/rolldown/issues/11344).
export {
  makeRead as makeReadRedisClient,
  makeReadWrite as makeReadWriteRedisClient,
  makeWrite as makeWriteRedisClient,
} from "@alchemy.run/redis/Client";

/**
 * Shared Redis command-client builders. NOT exported from `index.ts`.
 *
 * The RESP client lives in `alchemy/Redis`. These aliases keep the
 * `{Op}Http.ts` layers stable.
 */
export {
  makeRead as makeReadRedisClient,
  makeReadWrite as makeReadWriteRedisClient,
  makeWrite as makeWriteRedisClient,
} from "../Redis/index.ts";

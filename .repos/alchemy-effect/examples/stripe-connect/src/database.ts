import * as Cloudflare from "alchemy/Cloudflare";

/**
 * The platform's merchant table. One row per connected account, keyed by
 * the Stripe `acct_…` id. Files under `./migrations` are applied in order
 * on every deploy; already-applied migrations are skipped.
 */
export const Database = Cloudflare.D1.Database("Database", {
  migrations: "./migrations",
});

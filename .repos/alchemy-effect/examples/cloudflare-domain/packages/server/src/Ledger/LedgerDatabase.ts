import * as Cloudflare from "@alchemy.run/cloudflare";

/** The D1 database the Ledger projection writes, outside the domain model. */
export const LedgerDatabase = Cloudflare.D1.Database("LedgerDatabase", {
  migrations: "packages/server/migrations/ledger",
});

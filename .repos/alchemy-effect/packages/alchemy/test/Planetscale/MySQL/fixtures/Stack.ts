import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Planetscale from "@/Planetscale/index.ts";
import * as Effect from "effect/Effect";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared PlanetScale + Cloudflare wiring used by the MySQL Hyperdrive
 * fixture worker. A long-lived staging MySQL database (named
 * deterministically so reruns adopt the same resource) owns a feature
 * branch (which applies the fixture migrations) + password. The Hyperdrive
 * config points at the password's origin.
 */
// This module is bundled into the worker (hyperdrive-worker.ts imports it),
// so this also evaluates at worker startup, where the bundler leaves
// `import.meta.url` undefined. The fallback is never read there — resource
// props are only consumed at deploy time.
const migrationsDir = import.meta.url
  ? path.join(fileURLToPath(import.meta.url), "..", "migrations")
  : ".";

export const PlanetscaleDb = Effect.gen(function* () {
  const database = yield* Planetscale.MySQLDatabase("MySQLHyperdriveTestDb", {
    name: "alchemy-mysql-hyperdrive",
    region: { slug: "us-east" },
    clusterSize: "PS_10",
  });

  const branch = yield* Planetscale.MySQLBranch("MySQLHyperdriveTestBranch", {
    database,
    parentBranch: "main",
    isProduction: false,
    migrations: migrationsDir,
  });

  const password = yield* Planetscale.MySQLPassword(
    "MySQLHyperdriveTestPassword",
    {
      database,
      branch,
      role: "admin",
    },
  );

  return { database, branch, password };
});

export const Hyperdrive = Effect.gen(function* () {
  const { password } = yield* PlanetscaleDb;
  return yield* Cloudflare.Hyperdrive.Connection("MySQLHyperdriveTestEdge", {
    origin: password.origin,
    // The test asserts read-your-writes across separate HTTP requests;
    // Hyperdrive's query cache (60s default) would serve stale SELECTs.
    caching: { disabled: true },
  });
});

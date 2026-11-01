import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as Prisma from "@/Prisma/index.ts";
import * as Effect from "effect/Effect";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Neon + Prisma wiring for the Prisma ORM Worker E2E test: the contract
 * in this fixture directory is emitted and planned by {@link Prisma.Contract}
 * (no drift on a clean checkout — `generated/` and `migrations/` are checked
 * in), applied to a fresh Neon branch by {@link Prisma.Migrate}, and fronted
 * by a Hyperdrive for the Worker runtime client.
 */
export const Db = Effect.gen(function* () {
  // Resolved inside the effect (not at module scope) so it only runs at
  // deploy time — `import.meta.url` is undefined in the bundled worker.
  const configPath = yield* Effect.sync(() =>
    path.join(
      import.meta.url ? fileURLToPath(import.meta.url) : ".",
      "..",
      "prisma.config.ts",
    ),
  );

  const contract = yield* Prisma.Contract("PrismaOrmContract", {
    config: configPath,
  });

  const project = yield* Neon.Project("PrismaOrmProject", {
    region: "aws-us-east-1",
  });

  const branch = yield* Neon.Branch("PrismaOrmBranch", { project });

  const migrate = yield* Prisma.Migrate("PrismaOrmMigrate", {
    url: branch.connectionUri,
    contract,
  });

  return { contract, project, branch, migrate };
});

export const Hyperdrive = Effect.gen(function* () {
  const { branch } = yield* Db;
  return yield* Cloudflare.Hyperdrive.Connection("PrismaOrmEdge", {
    origin: branch.origin,
    // The test asserts read-after-write across separate fetch events;
    // Hyperdrive's default SELECT caching could serve pre-insert results.
    caching: { disabled: true },
  });
});

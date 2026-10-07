import * as Neon from "@/Neon";
import * as Prisma from "@/Prisma";
import * as SQL from "@/SQL/Postgres.ts";
import * as Stack from "@/Stack";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({
  providers: Layer.mergeAll(Prisma.providers(), Neon.providers()),
});

const HOOK_TIMEOUT = 300_000;

const CONFIG_SOURCE = `
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";
import { definePrismaConfig } from "prisma/config";

export default definePrismaConfig({
  orm: ormConfig({
    contract: "./contract.prisma",
    output: "./generated",
  }),
});
`;

const CONTRACT_SOURCE = `model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
}
`;

const DRIFTED_CONTRACT_SOURCE =
  CONTRACT_SOURCE +
  `
model Post {
  id    Int    @id @default(autoincrement())
  title String
}
`;

const stageWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Stage inside the repo (not the OS temp dir): prisma.config.ts
  // imports `@prisma/orm-postgres/config`, resolved by walking up from the
  // config file to the workspace node_modules.
  const cwd = yield* Effect.sync(() => process.cwd());
  const tempParent = path.join(cwd, ".alchemy", "tmp");
  yield* fs.makeDirectory(tempParent, { recursive: true });
  const root = yield* fs.makeTempDirectory({
    directory: tempParent,
    prefix: "alchemy-prisma-migrate-test-",
  });
  yield* fs.writeFileString(path.join(root, "prisma.config.ts"), CONFIG_SOURCE);
  const contractPath = path.join(root, "contract.prisma");
  yield* fs.writeFileString(contractPath, CONTRACT_SOURCE);
  return {
    root,
    contractPath,
    configPath: path.join(root, "prisma.config.ts"),
  };
});

/** Out-of-band observation of the migrated database via a raw pg client. */
const queryTables = (url: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SQL.Postgres({ url: Redacted.make(url) });
      const rows = yield* sql<{ table_name: string }>`
        select table_name from information_schema.tables
        where table_schema = 'public'
      `;
      return rows.map((row) => row.table_name).sort();
    }),
  );

const queryMarker = (url: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SQL.Postgres({ url: Redacted.make(url) });
      const rows = yield* sql<{ core_hash: string }>`
        select core_hash from prisma_contract.marker where space = 'app'
      `;
      return rows[0]?.core_hash;
    }),
  );

const getStatus = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack.Stack;
  const s = yield* state.get({ stack: stk.name, stage: stk.stage, fqn });
  return s?.status;
});

test.provider(
  "applies planned migrations to a Neon branch and converges",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ws = yield* stageWorkspace;

      yield* stack.destroy();

      const deployStack = () =>
        stack.deploy(
          Effect.gen(function* () {
            const contract = yield* Prisma.Contract("app-contract", {
              config: ws.configPath,
            });
            const project = yield* Neon.Project("PrismaMigrateProject");
            const branch = yield* Neon.Branch("PrismaMigrateBranch", {
              project,
            });
            const migrate = yield* Prisma.Migrate("app-migrate", {
              url: branch.connectionUri,
              contract,
            });
            return { contract, branch, migrate };
          }),
        );

      // 1. Greenfield: plans the initial package and bootstraps the database.
      const initial = yield* deployStack();
      expect(initial.migrate.markerHash).toEqual(initial.contract.contractHash);

      const tables = yield* queryTables(initial.branch.connectionUri);
      expect(tables).toContain("user");
      expect(tables).not.toContain("post");
      expect(yield* queryMarker(initial.branch.connectionUri)).toEqual(
        initial.contract.contractHash,
      );

      // 2. Re-deploy with no drift: both resources are noops.
      yield* deployStack();
      expect(yield* getStatus("app-contract")).toEqual("created");
      expect(yield* getStatus("app-migrate")).toEqual("created");

      // 3. Contract drift: a new package is planned and applied in one deploy.
      yield* fs.writeFileString(ws.contractPath, DRIFTED_CONTRACT_SOURCE);
      yield* Effect.sleep("1 second");

      const drifted = yield* deployStack();
      expect(yield* getStatus("app-migrate")).toEqual("updated");
      expect(drifted.migrate.markerHash).toEqual(drifted.contract.contractHash);
      expect(drifted.migrate.markerHash).not.toEqual(
        initial.migrate.markerHash,
      );

      const driftedTables = yield* queryTables(drifted.branch.connectionUri);
      expect(driftedTables).toContain("user");
      expect(driftedTables).toContain("post");
      expect(yield* queryMarker(drifted.branch.connectionUri)).toEqual(
        drifted.contract.contractHash,
      );

      // 4. Destroy never unwinds the database: the branch is deleted with the
      // stack (Neon owns it), but Migrate's delete itself is a no-op — pinned
      // here by the destroy completing even though tables exist.
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:project",
      "provider:prisma",
      "provider:prisma:orm",
      "live",
    ],
    timeout: HOOK_TIMEOUT,
  },
);

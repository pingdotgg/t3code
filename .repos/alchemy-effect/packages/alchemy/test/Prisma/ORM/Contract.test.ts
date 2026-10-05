import * as Prisma from "@/Prisma";
import * as Provider from "@/Provider";
import * as Stack from "@/Stack";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Prisma.providers() });

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

const CONTRACT_SOURCE = `// use prisma-8
model User {
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

// Making \`name\` required forces a data transform on existing rows, which
// Prisma renders as unfilled placeholder(...) closures.
const PLACEHOLDER_CONTRACT_SOURCE = CONTRACT_SOURCE.replace(
  "name  String?",
  "name  String",
);

const TS_CONFIG_SOURCE = `
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";
import { definePrismaConfig } from "prisma/config";

export default definePrismaConfig({
  orm: ormConfig({
    contract: "./contract.ts",
    output: "./generated",
  }),
});
`;

// The TypeScript-authored form (Prisma 8's headline direction): the same
// contract as CONTRACT_SOURCE, via the defineContract builder DSL.
const TS_CONTRACT_SOURCE = `
import { defineContract } from "@prisma/orm-postgres/contract-builder";

export const contract = defineContract({}, ({ field, model }) => ({
  models: {
    User: model("User", {
      fields: {
        id: field.id.uuidv7String(),
        email: field.text().unique(),
        name: field.text().optional(),
      },
    }),
  },
}));
`;

const stageWorkspace = (contractSource: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Stage inside the repo (not the OS temp dir): prisma.config.ts
    // imports `@prisma/orm-postgres/config`, and bun resolves that bare
    // import by walking up from the config file — which only finds
    // `node_modules` when the staging dir lives in the workspace.
    const cwd = yield* Effect.sync(() => process.cwd());
    const tempParent = path.join(cwd, ".alchemy", "tmp");
    yield* fs.makeDirectory(tempParent, { recursive: true });
    const root = yield* fs.makeTempDirectory({
      directory: tempParent,
      prefix: "alchemy-prisma-contract-test-",
    });
    yield* fs.writeFileString(
      path.join(root, "prisma.config.ts"),
      CONFIG_SOURCE,
    );
    const contractPath = path.join(root, "contract.prisma");
    yield* fs.writeFileString(contractPath, contractSource);
    return {
      root,
      contractPath,
      configPath: path.join(root, "prisma.config.ts"),
      migrationsDir: path.join(root, "migrations"),
    };
  });

const readPackageDirs = (migrationsDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appDir = path.join(migrationsDir, "app");
    const exists = yield* fs.exists(appDir);
    if (!exists) return [] as string[];
    return (yield* fs.readDirectory(appDir)).sort();
  });

const readPackageMeta = (migrationsDir: string, dirName: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs.readFileString(
      path.join(migrationsDir, "app", dirName, "migration.json"),
    );
    return JSON.parse(text) as {
      from: string | null;
      to: string;
      migrationHash: string;
    };
  });

const getStatus = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack.Stack;
  const s = yield* state.get({ stack: stk.name, stage: stk.stage, fqn });
  return s?.status;
});

test.provider(
  "initial deploy emits the contract and plans the first migration",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(CONTRACT_SOURCE);

      const contract = yield* stack.deploy(
        Prisma.Contract("app-contract", { config: ws.configPath }),
      );

      // Emitted artifacts land in the config's output dir.
      expect(
        yield* fs.exists(path.join(ws.root, "generated", "contract.json")),
      ).toBe(true);
      expect(
        yield* fs.exists(path.join(ws.root, "generated", "contract.d.ts")),
      ).toBe(true);

      // One migration package planned from the empty contract to the head.
      const dirs = yield* readPackageDirs(ws.migrationsDir);
      expect(dirs).toHaveLength(1);
      const meta = yield* readPackageMeta(ws.migrationsDir, dirs[0]!);
      expect(meta.from).toBeNull();
      expect(meta.to).toEqual(contract.contractHash);
      expect(contract.migrations).toEqual(dirs);
    }),
  { tags: ["provider:prisma", "provider:prisma:orm", "live"] },
);

test.provider(
  "repeated deploys with no contract drift stay noop, not update (spurious updates would cascade into Prisma.Migrate)",
  (stack) =>
    Effect.gen(function* () {
      const ws = yield* stageWorkspace(CONTRACT_SOURCE);

      yield* stack.deploy(
        Prisma.Contract("app-contract", { config: ws.configPath }),
      );
      expect(yield* getStatus("app-contract")).toEqual("created");

      yield* stack.deploy(
        Prisma.Contract("app-contract", { config: ws.configPath }),
      );
      expect(yield* getStatus("app-contract")).toEqual("created");

      // No duplicate package was planned (`migration plan` without an
      // explicit --from would happily re-plan from empty every run).
      expect(yield* readPackageDirs(ws.migrationsDir)).toHaveLength(1);
    }),
  { tags: ["provider:prisma", "provider:prisma:orm", "live"] },
);

test.provider(
  "deploy after a real contract change updates the resource",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ws = yield* stageWorkspace(CONTRACT_SOURCE);

      const initial = yield* stack.deploy(
        Prisma.Contract("app-contract", { config: ws.configPath }),
      );
      const [initialDir] = yield* readPackageDirs(ws.migrationsDir);

      yield* fs.writeFileString(ws.contractPath, DRIFTED_CONTRACT_SOURCE);
      yield* Effect.sleep("1 second");

      const drifted = yield* stack.deploy(
        Prisma.Contract("app-contract", { config: ws.configPath }),
      );

      expect(yield* getStatus("app-contract")).toEqual("updated");
      expect(drifted.contractHash).not.toEqual(initial.contractHash);

      // The new package chains from the previous head.
      const dirs = yield* readPackageDirs(ws.migrationsDir);
      expect(dirs).toHaveLength(2);
      const initialMeta = yield* readPackageMeta(ws.migrationsDir, initialDir!);
      const newDir = dirs.find((dir) => dir !== initialDir);
      const newMeta = yield* readPackageMeta(ws.migrationsDir, newDir!);
      expect(newMeta.from).toEqual(initialMeta.to);
      expect(newMeta.to).toEqual(drifted.contractHash);
    }),
  { tags: ["provider:prisma", "provider:prisma:orm", "live"] },
);

test.provider(
  "TypeScript-authored contracts emit, plan, and get resolvable types",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(CONTRACT_SOURCE);
      // Swap in the TS-authored form of the same workspace.
      yield* fs.remove(ws.contractPath);
      yield* fs.writeFileString(
        path.join(ws.root, "prisma.config.ts"),
        TS_CONFIG_SOURCE,
      );
      yield* fs.writeFileString(
        path.join(ws.root, "contract.ts"),
        TS_CONTRACT_SOURCE,
      );

      const contract = yield* stack.deploy(
        Prisma.Contract("ts-contract", { config: ws.configPath }),
      );

      const dirs = yield* readPackageDirs(ws.migrationsDir);
      expect(dirs).toHaveLength(1);
      expect((yield* readPackageMeta(ws.migrationsDir, dirs[0]!)).to).toEqual(
        contract.contractHash,
      );

      // The CLI emits unpublished @internal/* specifiers for TS-authored
      // contracts; the resource must rewrite them to the public subpaths or
      // the emitted types cannot resolve in a user project.
      const dts = yield* fs.readFileString(
        path.join(ws.root, "generated", "contract.d.ts"),
      );
      expect(dts).not.toContain("@internal/");
      expect(dts).toContain("@prisma/orm-postgres/");
    }),
  { tags: ["provider:prisma", "provider:prisma:orm", "live"] },
);

test.provider(
  "list returns [] (non-listable local build artifact)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Prisma.Contract);
      const all = yield* provider.list();
      expect(all).toEqual([]);

      yield* stack.destroy();
    }),
  { tags: ["provider:prisma", "provider:prisma:orm", "live"] },
);

test.provider(
  "refuses plans with unfilled placeholders (data transforms need a human decision)",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ws = yield* stageWorkspace(CONTRACT_SOURCE);

      yield* stack.deploy(
        Prisma.Contract("app-contract", { config: ws.configPath }),
      );

      // name String? -> String needs a backfill for existing NULL rows; the
      // planned SQL runs against a real database later in the same deploy,
      // so the resource must fail with guidance instead of deciding.
      yield* fs.writeFileString(ws.contractPath, PLACEHOLDER_CONTRACT_SOURCE);
      yield* Effect.sleep("1 second");

      const result = yield* Effect.result(
        stack.deploy(
          Prisma.Contract("app-contract", { config: ws.configPath }),
        ),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("placeholder");
        expect(String(result.failure)).toContain("migration.ts");
      }
    }),
  { tags: ["provider:prisma", "provider:prisma:orm", "live"] },
);

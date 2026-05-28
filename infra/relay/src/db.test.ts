import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { relayPostgresDatabaseRegion } from "./db.ts";
import { parseJsonString } from "./persistence/json.ts";

const migrationsDir = "migrations/postgres";
const schemaFile = "src/schema.ts";
const NodeTestServices = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

class DbMigrationTestError extends Data.TaggedError("DbMigrationTestError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

interface DrizzleKitPostgresApi {
  readonly generateDrizzleJson: (
    imports: Record<string, unknown>,
    prevId?: string,
    schemaFilters?: ReadonlyArray<string>,
  ) => Promise<unknown>;
  readonly generateMigration: (prev: unknown, cur: unknown) => Promise<ReadonlyArray<string>>;
}

const readMigrationDirectories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(migrationsDir);
  const directories = yield* Effect.all(
    entries.map((entry) =>
      fs
        .stat(path.join(migrationsDir, entry))
        .pipe(Effect.map((stat) => (stat.type === "Directory" ? entry : null))),
    ),
  );
  return directories.filter((entry): entry is string => entry !== null).sort();
});

const readMigrationSqlFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = yield* readMigrationDirectories;
  const files = yield* Effect.all(
    directories.map((directory) =>
      Effect.gen(function* () {
        const migrationPath = path.join(migrationsDir, directory, "migration.sql");
        const exists = yield* fs.exists(migrationPath);
        if (!exists) return null;
        const sql = yield* fs.readFileString(migrationPath);
        return { directory, sql };
      }),
    ),
  );
  return files.filter(
    (file): file is { readonly directory: string; readonly sql: string } => file !== null,
  );
});

const readLatestMigrationSnapshot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = yield* readMigrationDirectories;
  const directoriesWithSnapshots = yield* Effect.all(
    directories.map((directory) =>
      fs
        .exists(path.join(migrationsDir, directory, "snapshot.json"))
        .pipe(Effect.map((exists) => (exists ? directory : null))),
    ),
  );
  const latestDirectory = directoriesWithSnapshots.findLast(
    (directory): directory is string => directory !== null,
  );
  if (!latestDirectory) {
    return null;
  }
  const snapshotPath = path.join(migrationsDir, latestDirectory, "snapshot.json");
  const exists = yield* fs.exists(snapshotPath);
  if (!exists) {
    return {
      directory: latestDirectory,
      snapshot: null,
    };
  }
  const snapshot = yield* parseJsonString(yield* fs.readFileString(snapshotPath));
  return {
    directory: latestDirectory,
    snapshot,
  };
});

const loadDrizzleKit = Effect.tryPromise({
  try: () => import("drizzle-kit/api-postgres") as Promise<DrizzleKitPostgresApi>,
  catch: (cause) =>
    new DbMigrationTestError({
      message: "failed to load drizzle-kit postgres api",
      cause,
    }),
});

const loadRelaySchema = Effect.gen(function* () {
  const path = yield* Path.Path;
  return yield* Effect.tryPromise({
    try: () => import(path.resolve(schemaFile)) as Promise<Record<string, unknown>>,
    catch: (cause) =>
      new DbMigrationTestError({
        message: "failed to load relay schema",
        cause,
      }),
  });
});

describe("relay database migrations", () => {
  it("pins the PlanetScale database near west coast Worker traffic", () => {
    expect(relayPostgresDatabaseRegion).toEqual({ slug: "us-west" });
  });

  it.effect("does not leave empty generated migration directories behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directories = yield* readMigrationDirectories;
      const emptyDirectories = yield* Effect.all(
        directories.map((directory) =>
          fs
            .readDirectory(path.join(migrationsDir, directory))
            .pipe(Effect.map((entries) => (entries.length === 0 ? directory : null))),
        ),
      ).pipe(Effect.map((entries) => entries.filter((entry): entry is string => entry !== null)));

      expect(emptyDirectories).toEqual([]);
    }).pipe(Effect.provide(NodeTestServices)),
  );

  it.effect("starts from a single baseline migration", () =>
    Effect.gen(function* () {
      const migrations = yield* readMigrationSqlFiles;

      expect(migrations).toHaveLength(1);
      expect(migrations[0]?.directory).toContain("baseline");
      expect(migrations[0]?.sql).toContain('CREATE TABLE "relay_environment_credentials"');
      expect(migrations[0]?.sql).toContain('"environment_public_key" text NOT NULL');
    }).pipe(Effect.provide(NodeTestServices)),
  );

  it.effect(
    "keeps the latest migration snapshot aligned with the relay schema",
    () =>
      Effect.gen(function* () {
        const latest = yield* readLatestMigrationSnapshot;
        expect(latest).not.toBeNull();
        expect(latest?.snapshot, `${latest?.directory} is missing snapshot.json`).not.toBeNull();

        const kit = yield* loadDrizzleKit;
        const relaySchema = yield* loadRelaySchema;
        const currentSnapshot = yield* Effect.tryPromise({
          try: () => kit.generateDrizzleJson(relaySchema),
          catch: (cause) =>
            new DbMigrationTestError({
              message: "failed to generate current drizzle snapshot",
              cause,
            }),
        });
        const statements = yield* Effect.tryPromise({
          try: () => kit.generateMigration(latest?.snapshot, currentSnapshot),
          catch: (cause) =>
            new DbMigrationTestError({
              message: "failed to diff relay schema",
              cause,
            }),
        });

        expect(statements).toEqual([]);
      }).pipe(Effect.provide(NodeTestServices)),
    20_000,
  );
});

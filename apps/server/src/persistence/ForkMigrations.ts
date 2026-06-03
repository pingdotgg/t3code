/**
 * ForkMigrations - migration runner for fork-only SQLite state.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./ForkMigrations/001_ProjectionThreadGoals.ts";

export const migrationEntries = [[1, "ProjectionThreadGoals", Migration0001]] as const;

export const makeMigrationLoader = () =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  yield* Effect.log("Running fork migrations...");
  const executedMigrations = yield* run({ loader: makeMigrationLoader() });
  yield* Effect.log("Fork migrations ran successfully").pipe(
    Effect.annotateLogs({ migrations: executedMigrations.map(([id, name]) => `${id}_${name}`) }),
  );
  return executedMigrations;
});

export const ForkMigrationsLive = Layer.effectDiscard(runForkMigrations());

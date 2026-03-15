/**
 * MigrationsLive - Migration runner with inline loader
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * Migrations run automatically when the MigrationsLive layer is provided,
 * ensuring the database schema is up-to-date before the application starts.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ServiceMap from "effect/ServiceMap"
import * as Migrator from "effect/unstable/sql/Migrator"
import Migration0001 from "./Migrations/001_TodoSchema.ts"

const loader = Migrator.fromRecord({
  "1_TodoSchema": Migration0001
})

const run = Migrator.make({})

export const runMigrations = Effect.gen(function*() {
  yield* Effect.log("Running migrations...")
  yield* run({ loader })
  yield* Effect.log("Migrations ran successfully")
})

export interface MigrationsReadyApi {
  readonly ready: true
}

export class MigrationsReady extends ServiceMap.Service<MigrationsReady, MigrationsReadyApi>()(
  "effect-http-ws-cli/MigrationsReady"
) {}

export const MigrationsLive = Layer.effect(
  MigrationsReady,
  runMigrations.pipe(
    Effect.as(MigrationsReady.of({ ready: true }))
  )
)

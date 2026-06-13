import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import * as Migrator from "effect/unstable/sql/Migrator"

const migrationNames = (
  migrations: ReadonlyArray<Migrator.ResolvedMigration>
): ReadonlyArray<readonly [id: number, name: string]> => migrations.map(([id, name]) => [id, name] as const)

describe("Migrator", () => {
  describe("loaders", () => {
    it.effect("fromGlob accepts js, ts, mjs, and mts files", () =>
      Effect.gen(function*() {
        const migrations = yield* Migrator.fromGlob({
          "./migrations/0004_fourth.mts": () => Promise.resolve(Effect.void),
          "./migrations/0002_second.ts": () => Promise.resolve(Effect.void),
          "./migrations/0003_third.mjs": () => Promise.resolve(Effect.void),
          "./migrations/0001_first.js": () => Promise.resolve(Effect.void),
          "./migrations/0005_ignored.cjs": () => Promise.resolve(Effect.void)
        })

        assert.deepStrictEqual(migrationNames(migrations), [
          [1, "first"],
          [2, "second"],
          [3, "third"],
          [4, "fourth"]
        ])
      }))

    it.effect("fromBabelGlob accepts Js, Ts, Mjs, and Mts suffixes", () =>
      Effect.gen(function*() {
        const migrations = yield* Migrator.fromBabelGlob({
          _0004_fourthMts: Effect.void,
          _0002_secondTs: Effect.void,
          _0003_thirdMjs: Effect.void,
          _0001_firstJs: Effect.void
        })

        assert.deepStrictEqual(migrationNames(migrations), [
          [1, "first"],
          [2, "second"],
          [3, "third"],
          [4, "fourth"]
        ])
      }))

    it.effect("fromFileSystem accepts js, ts, mjs, and mts files", () =>
      Effect.gen(function*() {
        const migrations = yield* Migrator.fromFileSystem("/migrations").pipe(
          Effect.provide(FileSystem.layerNoop({
            readDirectory: () =>
              Effect.succeed([
                "0004_fourth.mts",
                "0002_second.ts",
                "0003_third.mjs",
                "0001_first.js",
                "0005_ignored.cjs"
              ])
          }))
        )

        assert.deepStrictEqual(migrationNames(migrations), [
          [1, "first"],
          [2, "second"],
          [3, "third"],
          [4, "fourth"]
        ])
      }))
  })
})

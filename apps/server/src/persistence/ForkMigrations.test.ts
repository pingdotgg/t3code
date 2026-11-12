import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  forkMigrationManifest,
  migrationManifest,
  runMigrations,
  upstreamMigrations,
} from "./Migrations.ts";
import titleState from "./Migrations/052_ProjectionThreadTitleState.ts";
import upstreamOrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";
import { FORK_MIGRATIONS_TABLE, legacyForkLedger } from "./splitLegacyForkLedger.ts";

const FIRST_LEGACY_FORK_ID = 52;
const upstreamIdByName = new Map<string, number>(migrationManifest.map(([id, name]) => [name, id]));
const forkIdByName = new Map<string, number>(forkMigrationManifest.map(([id, name]) => [name, id]));

/** Where a legacy single-ledger id lives now. */
const newSlot = (legacyId: number) => {
  if (legacyId < FIRST_LEGACY_FORK_ID) return { toMigrationInclusive: legacyId };
  const name = legacyForkLedger[legacyId - FIRST_LEGACY_FORK_ID]!;
  const upstreamId = upstreamIdByName.get(name);
  return upstreamId !== undefined
    ? { toMigrationInclusive: upstreamId }
    : { toForkMigrationInclusive: forkIdByName.get(name)! };
};

const ledgers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = (table: string) =>
    sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `.pipe(Effect.map((rows) => rows.map((row) => [row.migration_id, row.name] as const)));
  const forkTable = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${FORK_MIGRATIONS_TABLE}
  `;
  return {
    upstream: yield* read("effect_sql_migrations"),
    fork: forkTable.length === 0 ? null : yield* read(FORK_MIGRATIONS_TABLE),
  };
});

const schema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT IN ('effect_sql_migrations', ${FORK_MIGRATIONS_TABLE})
    ORDER BY type, name
  `;
});

/** Rewrites both ledgers into the single one fork builds wrote before the split. */
const toLegacyLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { upstream, fork } = yield* ledgers;
  const legacyId = (name: string) =>
    FIRST_LEGACY_FORK_ID + legacyForkLedger.findIndex((entry) => entry === name);
  const moved = [
    ...upstream.filter(([id]) => id >= FIRST_LEGACY_FORK_ID).map(([, name]) => name),
    ...(fork ?? []).map(([, name]) => name),
  ];
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${FIRST_LEGACY_FORK_ID}`;
  yield* sql`DROP TABLE IF EXISTS ${sql(FORK_MIGRATIONS_TABLE)}`;
  for (const name of moved) {
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${legacyId(name)}, ${name})`;
  }
});

const memory = NodeSqliteClient.layer({ filename: ":memory:" });

const freshFullDatabase = Effect.gen(function* () {
  yield* runMigrations();
  return { ledgers: yield* ledgers, schema: yield* schema };
}).pipe(Effect.provide(memory));

describe("fork migration ledger", () => {
  it.effect("keeps upstream's migration ids and names", () =>
    Effect.gen(function* () {
      const ref = "upstream/main";
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (args: ReadonlyArray<string>) =>
        spawner
          .string(ChildProcess.make("git", args, { stdin: "ignore", stderr: "ignore" }))
          .pipe(Effect.orDie);
      const readUpstream = git(["show", `${ref}:apps/server/src/persistence/Migrations.ts`]);
      // CI checkouts have no upstream remote, so fetch upstream's main when it is missing.
      let upstreamSource = yield* readUpstream;
      if (upstreamSource === "") {
        yield* git([
          "fetch",
          "--quiet",
          "--depth=1",
          "https://github.com/pingdotgg/t3code.git",
          `main:refs/remotes/${ref}`,
        ]);
        upstreamSource = yield* readUpstream;
      }
      const upstream = [...upstreamSource.matchAll(/^\s*\[(\d+), "(\w+)", Migration\d+\],$/gm)].map(
        ([, id, name]) => [Number(id), name] as const,
      );
      assert.isAbove(upstream.length, 0, `Cannot read or fetch upstream's migrations at ${ref}.`);
      // The fork may lag upstream, so ours must be a prefix of theirs.
      assert.deepStrictEqual(migrationManifest, upstream.slice(0, migrationManifest.length));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("runs fork migrations in the order fork builds shipped them", () => {
    assert.deepStrictEqual(
      forkMigrationManifest.map(([id]) => id),
      forkMigrationManifest.map((_, index) => index + 1),
    );
    const scheduled = migrationManifest
      .filter(([id]) => id >= FIRST_LEGACY_FORK_ID)
      .flatMap(([id, name]) => [
        ...forkMigrationManifest
          .filter(([, , after]) => after === id - 1)
          .map(([, forkName]) => forkName),
        name,
      ]);
    const latestUpstreamId = Math.max(...migrationManifest.map(([id]) => id));
    scheduled.push(
      ...forkMigrationManifest
        .filter(([, , after]) => after === latestUpstreamId)
        .map(([, name]) => name),
    );
    assert.deepStrictEqual(scheduled.slice(0, legacyForkLedger.length), [...legacyForkLedger]);
    assert.isTrue(forkMigrationManifest.every(([, , after]) => after <= latestUpstreamId));
  });

  it.effect("records a fresh database on both ledgers", () =>
    Effect.gen(function* () {
      const fresh = yield* freshFullDatabase;
      assert.deepStrictEqual(fresh.ledgers.upstream, migrationManifest);
      assert.deepStrictEqual(
        fresh.ledgers.fork,
        forkMigrationManifest.map(([id, name]) => [id, name] as const),
      );
    }),
  );

  it.effect.each(
    Array.from(
      { length: legacyForkLedger.length + 1 },
      (_, index) => FIRST_LEGACY_FORK_ID - 1 + index,
    ),
  )("splits a legacy ledger at %s without re-running or skipping anything", (legacyId) =>
    Effect.gen(function* () {
      const fresh = yield* freshFullDatabase;
      yield* Effect.gen(function* () {
        const target = newSlot(legacyId);
        yield* runMigrations(target);
        const before = yield* ledgers;
        yield* toLegacyLedger;

        assert.deepStrictEqual(yield* runMigrations(target), []);
        const split = yield* ledgers;
        assert.deepStrictEqual(split.upstream, before.upstream);
        assert.deepStrictEqual(split.fork ?? [], before.fork ?? []);

        yield* runMigrations();
        assert.deepStrictEqual(yield* ledgers, fresh.ledgers);
        assert.deepStrictEqual(yield* schema, fresh.schema);
      }).pipe(Effect.provide(memory));
    }),
  );

  /**
   * Names installs recorded below and at the first legacy slot, on top of the
   * legacy layout. Agent builds before fork main recorded profile snapshots at
   * 44, 48, 49 or 50 and agent profiles at 51, and a build carrying upstream's
   * title state recorded it at 52 before fork main took over the ledger.
   */
  const installs: ReadonlyArray<readonly [string, ReadonlyMap<number, string>]> = [
    [
      "agent builds that recorded profiles at 48 and 50",
      new Map([
        [48, "ProjectionThreadProfileSnapshot"],
        [50, "ProjectionThreadProfileSnapshot"],
        [51, "AgentProfileAndPullRequestCompatibility"],
      ]),
    ],
    [
      "agent builds that recorded profiles at 49 and 50",
      new Map([
        [49, "ProjectionThreadProfileSnapshot"],
        [50, "ProjectionThreadProfileSnapshot"],
        [51, "AgentProfileAndPullRequestCompatibility"],
      ]),
    ],
    [
      "agent builds that recorded the thread list state at 52",
      new Map([
        [50, "ProjectionThreadProfileSnapshot"],
        [51, "AgentProfileAndPullRequestCompatibility"],
        [52, "ProjectionThreadListState"],
      ]),
    ],
    [
      "a build that recorded upstream's title state at 52",
      new Map([
        [44, "ProjectionThreadProfileSnapshot"],
        [48, "ProjectionThreadProfileSnapshot"],
        [50, "ProjectionThreadProfileSnapshot"],
        [51, "AgentProfileAndPullRequestCompatibility"],
        [52, "ProjectionThreadTitleState"],
      ]),
    ],
    [
      "the same build, hand-relabelled at 52",
      new Map([
        [44, "ProjectionThreadProfileSnapshot"],
        [48, "ProjectionThreadProfileSnapshot"],
        [50, "ProjectionThreadProfileSnapshot"],
        [51, "AgentProfileAndPullRequestCompatibility"],
        [52, "AgentProfileAndPullRequestCompatibility"],
      ]),
    ],
  ];

  it.effect.each(
    installs.flatMap(([install, recorded]) =>
      [52, 53, 54, FIRST_LEGACY_FORK_ID + legacyForkLedger.length - 1].map((legacyId) => ({
        install,
        recorded,
        legacyId,
      })),
    ),
  )("splits a ledger from $install at $legacyId", ({ recorded, legacyId }) =>
    Effect.gen(function* () {
      const fresh = yield* freshFullDatabase;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(newSlot(legacyId));
        yield* toLegacyLedger;
        for (const [id, name] of recorded) {
          yield* sql`UPDATE effect_sql_migrations SET name = ${name} WHERE migration_id = ${id}`;
        }
        // Fork migrations 1 and 2 replay the others; the build that recorded this one ran it.
        if (recorded.get(FIRST_LEGACY_FORK_ID) === "ProjectionThreadTitleState") yield* titleState;

        yield* runMigrations();
        const split = yield* ledgers;
        assert.deepStrictEqual(
          split.upstream,
          fresh.ledgers.upstream.map(([id, name]) =>
            id < FIRST_LEGACY_FORK_ID ? ([id, recorded.get(id) ?? name] as const) : [id, name],
          ),
        );
        const listState = recorded.get(FIRST_LEGACY_FORK_ID) === "ProjectionThreadListState";
        assert.deepStrictEqual(
          split.fork,
          fresh.ledgers.fork?.map(([id, name]) =>
            id === 1 && listState ? ([id, "ProjectionThreadListState"] as const) : [id, name],
          ),
        );
        assert.deepStrictEqual(yield* schema, fresh.schema);
      }).pipe(Effect.provide(memory));
    }),
  );

  it.effect("brings a database written by upstream to the fork's schema", () =>
    Effect.gen(function* () {
      const tableColumns = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Upstream adds columns in a different order, so compare sets, not CREATE text.
        return yield* sql<{
          readonly type: string;
          readonly name: string;
          readonly columns: string;
        }>`
          SELECT m.type, m.name,
            coalesce((SELECT group_concat(name) FROM (
              SELECT name FROM pragma_table_info(m.name) ORDER BY name
            )), '') AS columns
          FROM sqlite_master m
          WHERE m.name NOT LIKE 'sqlite_%'
            AND m.name NOT IN ('effect_sql_migrations', ${FORK_MIGRATIONS_TABLE})
          ORDER BY m.type, m.name
        `;
      });
      const fresh = yield* Effect.gen(function* () {
        yield* runMigrations();
        // Only fork databases stage this; ScheduledTaskService imports and drops it at startup.
        return (yield* tableColumns).filter((entry) => entry.name !== "legacy_scheduled_tasks");
      }).pipe(Effect.provide(memory));
      yield* Effect.gen(function* () {
        yield* Migrator.make({})({
          loader: Migrator.fromRecord(
            Object.fromEntries(
              upstreamMigrations.map(([id, name, migration]) => [
                `${id}_${name}`,
                id === 55 ? upstreamOrchestrationV2 : migration,
              ]),
            ),
          ),
        });
        yield* runMigrations();
        assert.deepStrictEqual(yield* tableColumns, fresh);
      }).pipe(Effect.provide(memory));
    }),
  );

  it.effect.each([53, 54, 55, 56, 57])(
    "refuses a fork V2 preview at %s without changing schema, history, or data",
    (previewId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(newSlot(previewId - 1));
        yield* toLegacyLedger;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${previewId}, 'OrchestrationV2')`;
        yield* sql`CREATE TABLE preview_data (value TEXT)`;
        yield* sql`INSERT INTO preview_data VALUES ('preserve me')`;
        const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const before = yield* sql`SELECT * FROM sqlite_master ORDER BY name`;

        const exit = yield* Effect.exit(runMigrations());

        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), `${previewId}_OrchestrationV2`);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          history,
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY name`, before);
        assert.deepStrictEqual(yield* sql`SELECT * FROM preview_data`, [{ value: "preserve me" }]);
      }).pipe(Effect.provide(memory)),
  );
});

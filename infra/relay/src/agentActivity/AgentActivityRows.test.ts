import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PgClient } from "@effect/sql-pg/PgClient";
import { PGlite } from "@electric-sql/pglite";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as RelayDb from "../db.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";

describe("AgentActivityRows", () => {
  it.effect("reports only inserts and changed payloads as changed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pg = yield* Effect.acquireRelease(
        Effect.promise(() => PGlite.create()),
        (client) => Effect.promise(() => client.close()),
      );
      const migration = yield* fs.readFileString(
        new URL("../../migrations/postgres/20260527044716_baseline/migration.sql", import.meta.url)
          .pathname,
      );
      yield* Effect.promise(() => pg.exec(migration));
      const client = {
        unsafe: (query: string, params: ReadonlyArray<unknown> = []) => {
          const result = Effect.promise(() =>
            pg.query<Record<string, unknown>>(query, [...params]),
          );
          return Object.assign(result.pipe(Effect.map((result) => result.rows)), {
            values: result.pipe(
              Effect.map((result) =>
                result.rows.map((row) => result.fields.map((field) => row[field.name])),
              ),
            ),
          });
        },
      } as unknown as PgClient;
      const db = yield* makeWithDefaults().pipe(Effect.provideService(PgClient, client));
      const state: RelayAgentActivityState = {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        projectTitle: "Project",
        threadTitle: "Thread",
        modelTitle: "Model",
        phase: "running",
        headline: "Working",
        updatedAt: "1970-01-01T00:00:00.000Z",
        deepLink: "/threads/env/thread",
      };
      yield* Effect.gen(function* () {
        const rows = yield* AgentActivityRows.AgentActivityRows;
        const input = { environmentPublicKey: "key", state };
        expect(yield* rows.upsert(input)).toBe(true);
        expect(yield* rows.upsert(input)).toBe(false);
        expect(
          yield* rows.upsert({
            ...input,
            state: { ...state, phase: "completed", headline: "Done" },
          }),
        ).toBe(true);
        expect(
          yield* rows.upsert({
            ...input,
            state: { ...state, headline: "Done", phase: "completed" },
          }),
        ).toBe(false);
      }).pipe(
        Effect.provide(
          AgentActivityRows.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db))),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

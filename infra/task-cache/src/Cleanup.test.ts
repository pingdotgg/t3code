// @effect-diagnostics nodeBuiltinImport:off - real SQLite exercises concurrent D1 claims and accounting.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import { cleanup } from "../vendor/vite-plus-remote-cache-cloudflare/src/database.ts";
import * as Cache from "./Cache.ts";
import * as Cleanup from "./Cleanup.ts";

it.effect("cleans three full disjoint batches within the D1 invocation budget", () =>
  Effect.gen(function* () {
    const sqlite = new NodeSqlite.DatabaseSync(":memory:");
    try {
      sqlite.exec(
        NodeFS.readFileSync(
          new URL(
            "../vendor/vite-plus-remote-cache-cloudflare/migrations/0001_cache.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      sqlite.exec(`
        INSERT INTO scopes (scope_id, endpoint, repository, repository_id, repository_owner_id, branch)
        VALUES ('fixture', 'https://cache.example', 'owner/repo', '1', '2', 'refs/heads/main');
        WITH RECURSIVE ids(id) AS (SELECT 0 UNION ALL SELECT id+1 FROM ids WHERE id<1023)
        INSERT INTO generations (generation_id, scope_id, state, policy_version, token_exp,
          lease_until, gc_after, value_object, blob_object, charged_bytes)
        SELECT 'g'||id, 'fixture', 'retired', 1, unixepoch()+3600, 0, 0,
          'value/'||id, 'blob/'||id, 1 FROM ids;
        INSERT INTO generations (generation_id, scope_id, state, policy_version, token_exp,
          lease_until, gc_after, value_object, blob_object, charged_bytes)
        VALUES ('live', 'fixture', 'ready', 1, unixepoch()+3600, 0, unixepoch()+3600,
          'live/value', 'live/blob', 1);
      `);
      let queries = 0;
      const claims: string[][] = [];
      const deleted = new Set<string>();
      const query = () => {
        if (++queries > 1000) throw new Error("D1 query budget exceeded");
      };
      const prepare = (sql: string) => {
        let args: NodeSqlite.SQLInputValue[] = [];
        const statement = {
          bind: (...values: NodeSqlite.SQLInputValue[]) => {
            args = values.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            );
            return statement;
          },
          all: async () => {
            query();
            const results = sqlite.prepare(sql).all(...args);
            if (sql.startsWith("UPDATE generations"))
              claims.push(results.map((row) => String(row.generation_id)));
            return { results };
          },
          run: async () => {
            query();
            if (sql.startsWith("DELETE FROM generations")) {
              const row = sqlite
                .prepare(
                  "SELECT value_object, blob_object FROM generations WHERE generation_id = ?",
                )
                .get(args[0]!);
              expect(deleted.has(String(row!.value_object))).toBe(true);
              expect(deleted.has(String(row!.blob_object))).toBe(true);
            }
            return sqlite.prepare(sql).run(...args);
          },
        };
        return statement;
      };
      const env = {
        GC_BATCH_SIZE: String(Cleanup.batchSize),
        INDEX: {
          prepare,
          batch: async (statements: ReturnType<typeof prepare>[]) =>
            Promise.all(statements.map((statement) => statement.run())),
        },
        ARTIFACTS: {
          delete: async (keys: string[]) => {
            for (const key of keys) {
              expect(deleted.has(key)).toBe(false);
              deleted.add(key);
            }
          },
        },
      } as unknown as Parameters<typeof cleanup>[0];
      yield* Cleanup.run().pipe(
        Effect.provide(
          Layer.succeed(Cache.Cache, {
            handle: () => Effect.die("unused"),
            cleanup: Effect.promise(() => cleanup(env)),
          }),
        ),
      );
      expect(claims.map((claim) => claim.length)).toEqual([256, 256, 256]);
      expect(new Set(claims.flat()).size).toBe(768);
      expect(queries).toBeLessThanOrEqual(1000);
      expect(deleted.size).toBe(1536);
      expect(deleted.has("live/value")).toBe(false);
      expect(sqlite.prepare("SELECT charged_bytes FROM scopes").get()).toEqual({
        charged_bytes: 257,
      });
      expect(sqlite.prepare("SELECT count(*) AS n FROM generations").get()).toEqual({ n: 257 });
    } finally {
      sqlite.close();
    }
  }),
);

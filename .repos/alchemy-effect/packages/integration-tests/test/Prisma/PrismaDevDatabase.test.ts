import { describe, expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import {
  closePrismaDevDatabase,
  ensurePrismaDevDatabase,
} from "../../../prisma/src/internal/PrismaDevDatabase.ts";

const queryAnswer = Effect.fn(
  function* (_connectionString: string) {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{ answer: number }>`select 42::int as answer`;
    return Number(rows[0]?.answer);
  },
  (effect, connectionString) =>
    effect.pipe(Effect.provide(PgClient.layer({ url: Redacted.make(connectionString) }))),
);

describe(
  "Prisma dev database",
  { tags: ["provider:prisma", "provider:prisma:database", "local"] },
  () => {
    it.effect(
      "rejects non-positive migration timeouts",
      () =>
        Effect.gen(function* () {
          const result = yield* ensurePrismaDevDatabase("dev:invalid-timeout", {
            migrateTimeoutSeconds: 0,
          }).pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(String(result.failure)).toContain(
              "migrateTimeoutSeconds must be a positive finite number",
            );
          }
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { tags: ["unit"] },
    );

    it.effect("starts @prisma/dev and returns usable direct and pooled URLs", () => {
      const basePort = 58000 + (process.pid % 1000);
      const databaseId = `dev:database:test-${process.pid}`;

      return Effect.gen(function* () {
        const attrs = yield* ensurePrismaDevDatabase(databaseId, {
          provider: "@prisma/dev",
          persistenceMode: "stateless",
          port: basePort,
          databasePort: basePort + 1,
          shadowDatabasePort: basePort + 2,
        });

        expect(attrs).toBeDefined();
        const direct = Redacted.value(attrs!.directConnectionString);
        const pooled = Redacted.value(attrs!.pooledConnectionString);

        expect(direct).toContain("127.0.0.1");
        expect(pooled).toMatch(/^prisma\+postgres:\/\//);
        expect(attrs!.host).toBe("127.0.0.1");

        const answer = yield* queryAnswer(direct);
        expect(answer).toBe(42);

        expect(yield* ensurePrismaDevDatabase(databaseId, false)).toBeUndefined();
        const afterDisable = yield* queryAnswer(direct).pipe(Effect.result);
        expect(Result.isFailure(afterDisable)).toBe(true);
      }).pipe(
        Effect.ensuring(closePrismaDevDatabase(databaseId).pipe(Effect.orDie)),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );
    });

    it.effect("redacts migration failures and terminates commands at the timeout", () => {
      const basePort = 59000 + (process.pid % 500);
      const databaseId = `dev:migration-test-${process.pid}`;
      const node = JSON.stringify(process.execPath);
      const options = {
        provider: "@prisma/dev" as const,
        persistenceMode: "stateless" as const,
        port: basePort,
        databasePort: basePort + 1,
        shadowDatabasePort: basePort + 2,
      };

      return Effect.gen(function* () {
        const attrs = yield* ensurePrismaDevDatabase(databaseId, options);
        expect(attrs).toBeDefined();
        const direct = Redacted.value(attrs!.directConnectionString);
        const pooled = Redacted.value(attrs!.pooledConnectionString);
        const apiKey = new URL(pooled).searchParams.get("api_key");
        expect(apiKey).toBeTruthy();

        const failed = yield* ensurePrismaDevDatabase(databaseId, {
          ...options,
          migrate: `exec ${node} -e 'const url = new URL(process.env.DATABASE_URL); console.error(process.env.DATABASE_URL); console.error(url.searchParams.get("api_key")); process.exit(7)'`,
          migrateTimeoutSeconds: 5,
        }).pipe(Effect.result);
        expect(Result.isFailure(failed)).toBe(true);
        if (Result.isFailure(failed)) {
          const message = String(failed.failure);
          expect(message).toContain("exit code 7");
          expect(message).toContain("[REDACTED]");
          expect(message).not.toContain(direct);
          expect(message).not.toContain(pooled);
          expect(message).not.toContain(apiKey!);
          expect(JSON.stringify(failed.failure)).not.toContain(apiKey!);
        }

        const overflow = yield* ensurePrismaDevDatabase(databaseId, {
          ...options,
          migrate: `exec ${node} -e 'process.stdout.write("x".repeat(1048577))'`,
          migrateTimeoutSeconds: 5,
        }).pipe(Effect.result);
        expect(Result.isFailure(overflow)).toBe(true);
        if (Result.isFailure(overflow)) {
          expect(String(overflow.failure)).toContain(
            "migration stdout exceeded the 1048576 byte safety limit",
          );
        }

        const timedOut = yield* TestClock.withLive(
          ensurePrismaDevDatabase(databaseId, {
            ...options,
            migrate: `exec ${node} -e 'setInterval(() => {}, 1000)'`,
            migrateTimeoutSeconds: 0.1,
          }),
        ).pipe(Effect.result);
        expect(Result.isFailure(timedOut)).toBe(true);
        if (Result.isFailure(timedOut)) {
          expect(String(timedOut.failure)).toContain(
            "timed out after 0.1 seconds and was terminated",
          );
        }
      }).pipe(
        Effect.ensuring(closePrismaDevDatabase(databaseId).pipe(Effect.orDie)),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );
    });
  },
);

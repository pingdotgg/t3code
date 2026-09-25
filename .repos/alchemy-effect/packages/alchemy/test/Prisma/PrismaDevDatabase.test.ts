import {
  closePrismaDevDatabase,
  ensurePrismaDevDatabase,
} from "@/Prisma/PrismaDevDatabase";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { Client } from "pg";

const toError = (message: string) => (cause: unknown) =>
  cause instanceof Error ? cause : new Error(`${message}: ${String(cause)}`);

const queryAnswer = Effect.fn(function* (connectionString: string) {
  const client = yield* Effect.sync(() => new Client({ connectionString }));
  yield* Effect.tryPromise({
    try: () => client.connect(),
    catch: toError("Failed to connect to local Prisma database"),
  });
  return yield* Effect.tryPromise({
    try: () => client.query("select 42::int as answer"),
    catch: toError("Failed to query local Prisma database"),
  }).pipe(
    Effect.map((result) => Number(result.rows[0]?.answer)),
    Effect.ensuring(
      Effect.tryPromise({
        try: () => client.end(),
        catch: toError("Failed to close local Prisma database client"),
      }).pipe(Effect.catch(() => Effect.void)),
    ),
  );
});

describe("Prisma dev database", () => {
  it.effect("rejects non-positive migration timeouts", () =>
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
  );

  it.effect(
    "starts @prisma/dev and returns usable direct and pooled URLs",
    () => {
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

        expect(
          yield* ensurePrismaDevDatabase(databaseId, false),
        ).toBeUndefined();
        const afterDisable = yield* queryAnswer(direct).pipe(Effect.result);
        expect(Result.isFailure(afterDisable)).toBe(true);
      }).pipe(
        Effect.ensuring(closePrismaDevDatabase(databaseId).pipe(Effect.orDie)),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );
    },
  );

  it.effect(
    "redacts migration failures and terminates commands at the timeout",
    () => {
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
    },
  );
});

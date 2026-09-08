import * as Alchemy from "alchemy";
import * as Drizzle from "alchemy/Drizzle";
import * as Fly from "alchemy/Fly";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as fs from "node:fs";
import * as path from "node:path";
import Stack from "../alchemy.run.ts";
import type { User } from "../src/schema.ts";
import { MIGRATE_TOKEN } from "../src/shared.ts";

/** A `User` row as it arrives over JSON — `createdAt` is an ISO string. */
type SerializedUser = Omit<User, "createdAt"> & { createdAt: string };

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Fly.providers(), Drizzle.providers()),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/**
 * Generated migration SQL, in journal order. `Drizzle.Schema` writes these
 * during the deploy in `beforeAll`, so read lazily inside the test.
 */
const readMigrationSql = (): string[] => {
  const dir = path.resolve(import.meta.dirname, "..", "migrations");
  return fs
    .readdirSync(dir)
    .filter((entry) => fs.existsSync(path.join(dir, entry, "migration.sql")))
    .sort()
    .map((entry) =>
      fs.readFileSync(path.join(dir, entry, "migration.sql"), "utf8"),
    );
};

/** Run a request, retrying non-200s through the fresh app's warmup. */
const executeOk = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(request).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new Error(`HTTP ${res.status}`)),
      ),
      // Bounded (~90s): machine boot + route warmup. Never use unbounded
      // exponential growth here — a genuinely broken route should surface
      // well inside the test timeout.
      Effect.retry({
        schedule: Schedule.spaced("2 seconds"),
        times: 45,
      }),
    );
  });

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 180_000,
});

test(
  "Service connects to Managed Postgres through Drizzle",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.clusterId).toBeString();
    expect(out.region).toBe("iad");
    expect(out.apiUrl).toBe(`https://${out.appName}.fly.dev`);

    // Apply the generated schema THROUGH the deployed Service. MPG is only
    // reachable on the org's private network, so the in-network Service is
    // the data plane for DDL too — the test never connects to the cluster
    // directly. The `/migrate` route is idempotent, so warmup retries are
    // safe.
    const migrations = readMigrationSql();
    expect(migrations.length).toBeGreaterThan(0);
    for (const sqlText of migrations) {
      const migrated = yield* executeOk(
        HttpClientRequest.post(`${out.apiUrl}/migrate`).pipe(
          HttpClientRequest.setHeader("x-migrate-token", MIGRATE_TOKEN),
          HttpClientRequest.bodyText(sqlText),
        ),
      );
      const { applied } = (yield* migrated.json) as { applied: number };
      expect(applied).toBeGreaterThan(0);
    }

    const health = yield* executeOk(
      HttpClientRequest.get(`${out.apiUrl}/health`),
    );
    expect(health.status).toBe(200);
    const body = (yield* health.json) as { ok: boolean; users: number };
    expect(body.ok).toBe(true);
    expect(body.users).toBeNumber();

    const created = yield* HttpClient.execute(
      HttpClientRequest.post(`${out.apiUrl}/users`),
    );
    expect(created.status).toBe(200);
    const createdBody = (yield* created.json) as { user: SerializedUser[] };
    expect(createdBody.user).toHaveLength(1);
    expect(createdBody.user[0]?.id).toBeNumber();
  }),
  { timeout: 240_000 },
);

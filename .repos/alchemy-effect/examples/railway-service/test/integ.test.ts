import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";
import { SECRET_NAME } from "../src/shared.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Railway.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const fetchOk = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new Error(`HTTP ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
  });

const stack = beforeAll(deploy(Stack), { timeout: 480_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 180_000,
});

test(
  "deploys the full graph and serves /health",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.projectId).toBeString();
    expect(out.environmentId).toBeString();
    expect(out.stagingId).toBeString();
    expect(out.stagingName).toBe("staging");
    expect(out.secretName).toBeString();
    expect(out.volumeId).toBeString();
    expect(out.postgresServiceId).toBeString();
    expect(out.postgresPublic).toBeString();
    expect(out.mysqlServiceId).toBeString();
    expect(out.mysqlName).toBeString();
    expect(out.databaseUrlName).toBe("APP_DATABASE_URL");
    expect(out.pingUrl).toMatch(/^https:\/\/.+\.up\.railway\.app$/);
    expect(out.groupId).toBeString();
    expect(out.redisServiceId).toBeString();
    expect(out.redisProxy).toContain(":");
    expect(out.bucketId).toBeString();
    expect(out.echoUrl).toMatch(/^https:\/\/.+\.up\.railway\.app$/);
    expect(out.apiUrl).toMatch(/^https:\/\/.+\.up\.railway\.app$/);
    expect(out.workerServiceId).toBeString();
    expect(out.workspaceId).toBeString();

    const health = yield* fetchOk(`${out.apiUrl}/health`);
    expect(health.status).toBe(200);
    const body = (yield* health.json) as { rows: unknown };
    expect(body.rows).toBeDefined();

    expect(out.pingUrl).toEqual(expect.any(String));
    const ping = yield* fetchOk(out.pingUrl!);
    expect(ping.status).toBe(200);
    const pingBody = (yield* ping.json) as { rows: unknown };
    expect(pingBody.rows).toBeDefined();
  }),
  { timeout: 180_000 },
);

test(
  "Variable is injected as env on /secret",
  Effect.gen(function* () {
    const out = yield* stack;
    const response = yield* fetchOk(`${out.apiUrl}/secret`);
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe(SECRET_NAME);
  }),
  { timeout: 60_000 },
);

test(
  "ReadWriteRedis round-trips a key on /redis",
  Effect.gen(function* () {
    const out = yield* stack;
    const response = yield* fetchOk(`${out.apiUrl}/redis`);
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { ok: boolean };
    expect(body.ok).toBe(true);
  }),
  { timeout: 60_000 },
);

test(
  "Bucket Put/Get/Head/List/Delete on /bucket",
  Effect.gen(function* () {
    const out = yield* stack;
    const response = yield* fetchOk(`${out.apiUrl}/bucket`);
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { ok: boolean };
    expect(body.ok).toBe(true);
  }),
  { timeout: 60_000 },
);

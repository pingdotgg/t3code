import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";
import { SECRET_NAME } from "../src/shared.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Fly.providers(),
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
        times: 20,
      }),
    );
  });

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 180_000,
});

test(
  "deploys Api + Worker and serves /health over fly.dev",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.appName).toBeString();
    expect(out.apiUrl).toBe(`https://${out.appName}.fly.dev`);
    expect(out.ip).toBeString();
    expect(out.secretName).toBe(SECRET_NAME);
    expect(out.workerMounts[0]?.volumeId).toBeString();
    expect(out.apiMachineId).not.toBe(out.workerMachineId);

    const health = yield* fetchOk(`${out.apiUrl}/health`);
    expect(health.status).toBe(200);
    const body = (yield* health.json) as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe(SECRET_NAME);
  }),
  { timeout: 180_000 },
);

test(
  "Fly.Secret is injected as env and present on /secret",
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

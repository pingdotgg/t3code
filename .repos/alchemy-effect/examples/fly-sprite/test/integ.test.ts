import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";

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

const stack = beforeAll(deploy(Stack), { timeout: 180_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
});

test(
  "deploys an effectful Sprite and serves HTTP",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.spriteId).toBeString();
    expect(out.name).toBeString();
    expect(out.url).toBeString();
    expect(out.url).toContain("sprites.app");
    expect(out.urlAuth).toBe("public");

    const health = yield* fetchOk(`${out.url}/health`);
    expect(health.status).toBe(200);
    const body = (yield* health.json) as { ok: boolean };
    expect(body.ok).toBe(true);
  }),
  { timeout: 120_000 },
);

import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";

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

const stack = beforeAll(deploy(Stack), { timeout: 180_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
});

test(
  "deploys http-echo on a Service and serves over up.railway.app",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.url).toBeString();
    expect(out.url).toMatch(/^https:\/\/.+\.up\.railway\.app$/);
    expect(out.projectId).toBeString();
    expect(out.serviceId).toBeString();

    const response = yield* fetchOk(out.url!);
    expect(response.status).toBe(200);
  }),
  { timeout: 120_000 },
);

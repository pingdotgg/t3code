/**
 * LIVE counterpart to test/dev.test.ts: deploys the exact same orders app
 * to real AWS (Test.make + deploy, no CLI) — VPC, shared ALB, Fargate
 * services, DynamoDB table, one-shot tasks — and drives the same HTTP
 * surface against the real load balancer.
 *
 * Requires AWS credentials and docker (the Api/SeedTask/Report images are
 * built locally and pushed to ECR). The first deploy provisions an ALB and
 * two Fargate services (~5-10 minutes).
 */
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
  state: Alchemy.localState(),
  stage: "test",
});

// The first deploy builds + pushes container images and waits for two
// Fargate services to stabilize behind the ALB.
const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 1_800_000,
});

type Outputs = {
  url: string;
  apiUrl: string;
  seedUrl: string;
  tableName: string;
};

const outputs = Effect.map(stack, (out) => out as unknown as Outputs);

/** GET with retries — fresh ALB targets take a moment to pass health checks. */
const getJson = Effect.fn(function* (url: string) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const res = yield* client.get(url).pipe(
    Effect.retry({
      schedule: Schedule.min([
        Schedule.exponential("1 second"),
        Schedule.spaced("5 seconds"),
      ]),
      times: 30,
    }),
  );
  return yield* res.json;
});

test(
  "the Api service serves /api/orders through the shared ALB",
  Effect.gen(function* () {
    const { apiUrl } = yield* outputs;
    const body = (yield* getJson(apiUrl)) as {
      count: number;
      orders: unknown[];
    };
    expect(body.count).toBeNumber();
  }),
  { timeout: 300_000 },
);

test(
  "the Web service serves the catch-all route",
  Effect.gen(function* () {
    const { url } = yield* outputs;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const res = yield* client.get(url).pipe(
      Effect.retry({
        schedule: Schedule.min([
          Schedule.exponential("1 second"),
          Schedule.spaced("5 seconds"),
        ]),
        times: 30,
      }),
    );
    const text = yield* res.text;
    expect(text).toContain("Server");
  }),
  { timeout: 300_000 },
);

test(
  "POST /api/seed launches the SeedTask and seeds the table",
  Effect.gen(function* () {
    const { apiUrl, seedUrl } = yield* outputs;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const seedRes = yield* client.post(seedUrl).pipe(
      Effect.retry({
        schedule: Schedule.spaced("5 seconds"),
        times: 12,
      }),
    );
    const seed = (yield* seedRes.json) as {
      taskArn?: string;
      failures: unknown[];
    };
    expect(seed.failures).toEqual([]);
    expect(seed.taskArn).toBeString();

    // The one-shot Fargate task must pull its image and run to completion
    // before the orders appear.
    const count = yield* getJson(apiUrl).pipe(
      Effect.map((body) => (body as { count: number }).count),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (count) => count >= 3,
        times: 60,
      }),
    );
    expect(count).toBeGreaterThanOrEqual(3);
  }),
  { timeout: 600_000 },
);

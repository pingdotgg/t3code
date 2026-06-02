import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Dataset } from "./fixtures/dataset.ts";
import AnalyticsEngineTestWorker from "./fixtures/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "AnalyticsEngineBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const dataset = yield* Dataset;
    const worker = yield* AnalyticsEngineTestWorker;
    return {
      dataset: dataset.dataset,
      url: worker.url.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deployed worker can write data points through the Analytics Engine binding",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");

    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(`${url}/write`).pipe(
      Effect.flatMap((res) =>
        res.status === 200 ? Effect.succeed(res) : Effect.fail(res),
      ),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { ok: boolean };
    expect(body.ok).toBe(true);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

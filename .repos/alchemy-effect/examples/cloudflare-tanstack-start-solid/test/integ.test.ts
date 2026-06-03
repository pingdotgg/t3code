import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)));
afterAll(
  Effect.gen(function* () {
    if (!process.env.NO_DESTROY) {
      yield* destroy(Stack);
    }
  }),
);

const coldStartRetry = Effect.retry({
  schedule: Schedule.exponential("500 millis").pipe(
    Schedule.both(Schedule.recurs(20)),
  ),
});

test(
  "serves the TanStack Start Solid app shell",
  Effect.gen(function* () {
    const { websiteUrl } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* client.get(websiteUrl).pipe(coldStartRetry);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    expect(html).toContain("TanStack Start Solid");
    expect(html).toContain(
      "Hello from TanStack Start Solid on Cloudflare.Vite",
    );
  }),
  { timeout: 180_000 },
);

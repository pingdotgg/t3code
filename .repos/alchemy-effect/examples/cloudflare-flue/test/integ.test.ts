import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "@alchemy.run/test/Bun";
import { createFlueClient } from "@flue/sdk";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

// Fresh `workers.dev` URLs transiently 404 while the route propagates.
// `Test.getWhenReady` retries until the Worker serves a real response.
const { getWhenReady } = Test;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
  timeout: 600_000,
});
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a workers.dev url");
  return String(url).replace(/\/+$/, "");
});

test(
  "serves a Hono route from app.ts",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/api/ping`);
    expect(res.status).toBe(200);
    expect(yield* res.json).toEqual({ pong: true });
  }),
  { timeout: 180_000 },
);

test(
  "the agent answers through Workers AI",
  Effect.gen(function* () {
    const url = yield* base;
    // Wait for the Worker before talking to the agent.
    yield* getWhenReady(`${url}/api/ping`);
    // A conversation lives at the agent's mount plus a caller-chosen id; the
    // agent's Durable Object runs the model call through `env.AI`.
    const client = createFlueClient({
      url: `${url}/agents/assistant/integ-${crypto.randomUUID()}`,
    });
    const reply = yield* Effect.tryPromise(async () => {
      const admission = await client.send({
        message: { kind: "user", body: "Reply with the single word PONG and nothing else." },
      });
      return client.read(admission);
    }).pipe(
      Effect.retry({
        schedule: Schedule.spaced("3 seconds"),
        times: 5,
      }),
    );
    expect(reply.text.toUpperCase()).toContain("PONG");
  }),
  { timeout: 300_000 },
);

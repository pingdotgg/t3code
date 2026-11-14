import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "@alchemy.run/test/Bun";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";
import { checkAssets, checkCallables, checkMcp, checkSchedule } from "./checks.ts";

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

const base = Effect.gen(function* () {
  const { url } = yield* stack;
  if (!url) throw new Error("expected the site to expose a workers.dev url");
  const base = String(url).replace(/\/+$/, "");
  const res = yield* getWhenReady(base);
  expect(res.status).toBe(200);
  // `/` is served by static assets, which can answer before the Worker
  // script has propagated; the agent routes then still return Cloudflare's
  // 1042 "No Workers script was found". Wait until an agent route answers.
  const agent = yield* getWhenReady(`${base}/agents/counter/readiness`);
  expect(agent.status).toBe(200);
  return base;
});

const check = (run: (url: string) => Promise<void>) =>
  Effect.gen(function* () {
    const url = yield* base;
    yield* Effect.promise(() => run(url));
  });

test("serves the client and static assets", check(checkAssets), { timeout: 180_000 });

test("calls the agent's callables over its WebSocket", check(checkCallables), {
  timeout: 180_000,
});

test("runs the agent's scheduled callback", check(checkSchedule), { timeout: 180_000 });

test("serves the MCP agent's tools", check(checkMcp), { timeout: 180_000 });

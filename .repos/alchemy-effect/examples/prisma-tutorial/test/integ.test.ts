import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Prisma.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});
const stack = beforeAll(
  destroy(Stack).pipe(Effect.andThen(deploy(Stack)), Effect.tap(Console.log)),
  { timeout: 120_000 },
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 120_000 });

test(
  "serves the frontend and queries real Postgres",
  Effect.gen(function* () {
    const { url, apiUrl } = yield* stack;
    const page = yield* Test.getWhenReady(String(url));
    expect(yield* page.text).toContain("Prisma database clock");
    const health = yield* Test.getWhenReady(`${apiUrl}/api/health`);
    expect(yield* health.json).toEqual({ ok: true });
    const response = yield* Test.getWhenReady(`${apiUrl}/api/time`);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    const data = (yield* response.json) as { time: string };
    expect(data.time).toMatch(/^\d{4}-\d{2}-\d{2} /);
    const client = yield* HttpClient.HttpClient;
    expect((yield* client.get(`${apiUrl}/missing`)).status).toBe(404);
    expect((yield* client.post(`${apiUrl}/api/time`)).status).toBe(405);
  }),
  { timeout: 120_000 },
);

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

// Pre-deploy cleanup must not close the suite's shared runtime scope.
const stack = beforeAll(
  Effect.sync(Test.defaultStage).pipe(
    Effect.flatMap((stage) => Alchemy.destroy({ stack: Stack, stage })),
    Effect.andThen(deploy(Stack)),
    Effect.tap(Console.log),
  ),
  {
    timeout: 120_000,
  },
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 120_000 });

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("Expected a deployed website URL");
  return String(url).replace(/\/+$/, "");
});

test(
  "serves the rendered home page",
  Effect.gen(function* () {
    const url = yield* base;
    const response = yield* Test.getWhenReady(url);
    expect(response.status).toBe(200);
    expect(yield* response.text).toContain("Hello from vinext on Prisma!");
  }),
  { timeout: 120_000 },
);

test(
  "serves a static asset without falling back to HTML",
  Effect.gen(function* () {
    const url = yield* base;
    const response = yield* Test.getWhenReady(`${url}/example.json`);
    expect(response.status).toBe(200);
    expect(yield* response.json).toEqual({
      framework: "vinext",
      greeting: "Hello from vinext on Prisma!",
    });
  }),
  { timeout: 120_000 },
);

test(
  "serves the ISR route and reports missing routes as 404",
  Effect.gen(function* () {
    const url = yield* base;
    const isr = yield* Test.getWhenReady(`${url}/isr`);
    expect(isr.status).toBe(200);
    expect(yield* isr.text).toContain("revalidate 60s");
    const missing = yield* HttpClient.get(`${url}/missing-route`);
    expect(missing.status).toBe(404);
  }),
  { timeout: 120_000 },
);

test(
  "serves a request-dependent endpoint with runtime environment",
  Effect.gen(function* () {
    const url = yield* base;
    for (const name of ["Prisma", "Alchemy"]) {
      const response = yield* Test.getWhenReady(
        `${url}/api/hello?name=${name}`,
      );
      expect(response.status).toBe(200);
      expect(yield* response.json).toEqual({
        name,
        greeting: "Hello from vinext on Prisma!",
      });
    }
  }),
  { timeout: 120_000 },
);

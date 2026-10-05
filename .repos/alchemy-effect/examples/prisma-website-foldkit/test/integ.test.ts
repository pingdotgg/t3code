import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Prisma.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const stack = beforeAll(
  destroy(Stack).pipe(Effect.andThen(deploy(Stack)), Effect.tap(Console.log)),
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
  "serves the application shell",
  Effect.gen(function* () {
    const url = yield* base;
    const response = yield* Test.getWhenReady(url);
    expect(response.status).toBe(200);
    expect(yield* response.text).toContain("Foldkit on Prisma");
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
      framework: "Foldkit",
      greeting: "Hello from Foldkit on Prisma!",
    });
  }),
  { timeout: 120_000 },
);

test(
  "serves the compiled browser entry",
  Effect.gen(function* () {
    const url = yield* base;
    const page = yield* Test.getWhenReady(url);
    const html = yield* page.text;
    const source = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
    expect(source).toBeDefined();
    if (!source) throw new Error("Expected a compiled JavaScript entry");
    const script = yield* Test.getWhenReady(new URL(source, url).href);
    expect(script.status).toBe(200);
    const body = yield* script.text;
    expect(body.length).toBeGreaterThan(100);
    expect(body.trimStart().startsWith("<!doctype")).toBe(false);
  }),
  { timeout: 120_000 },
);

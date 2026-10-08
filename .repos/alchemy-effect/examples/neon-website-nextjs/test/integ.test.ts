import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Neon.providers(),
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
  "streams route output and serves image and redirect paths",
  Effect.gen(function* () {
    const url = yield* base;
    const stream = yield* Test.getWhenReady(`${url}/api/stream`);
    expect(stream.status).toBe(200);
    expect(yield* stream.text).toBe("data: first\n\ndata: second\n\n");
    const image = yield* Test.getWhenReady(`${url}/logo.svg`);
    expect(image.headers["content-type"]).toContain("image/svg+xml");
    const redirect = yield* HttpClient.get(`${url}/redirect`).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
      }),
    );
    expect(redirect.status).toBe(307);
    expect(redirect.headers.location).toBe(`${url}/?redirected=yes`);
    const missing = yield* HttpClient.get(`${url}/not-a-real-page`);
    expect(missing.status).toBe(404);
  }),
  { timeout: 120_000 },
);

test(
  "serves the rendered home page",
  Effect.gen(function* () {
    const url = yield* base;
    const response = yield* Test.getWhenReady(url);
    expect(response.status).toBe(200);
    expect(yield* response.text).toContain("Hello from Next.js on Neon!");
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
      framework: "Next.js",
      greeting: "Hello from Next.js on Neon!",
    });
  }),
  { timeout: 120_000 },
);

test(
  "serves a request-dependent endpoint with runtime environment",
  Effect.gen(function* () {
    const url = yield* base;
    for (const name of ["Neon", "Alchemy"]) {
      const response = yield* Test.getWhenReady(
        `${url}/api/hello?name=${name}`,
      );
      expect(response.status).toBe(200);
      expect(yield* response.json).toEqual({
        name,
        greeting: "Hello from Next.js on Neon!",
      });
    }
  }),
  { timeout: 120_000 },
);

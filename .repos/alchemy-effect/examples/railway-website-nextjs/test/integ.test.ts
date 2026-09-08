import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

// A fresh Railway deployment (and the Railway Service behind it) can serve
// transient 404/5xx responses while it propagates. `Test.getWhenReady`
// fails on that cold-start window and retries until the site serves a
// real response.
const { getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// While the asset manifest and Railway edge caches are still
// propagating, a 200 body can be stale — the status alone can't
// distinguish "not yet" from "served", so retry until the body matches.
const getBodyWhenReady = (url: string, expected: string) =>
  Effect.gen(function* () {
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const body = yield* res.text;
    if (!body.includes(expected)) {
      return yield* Effect.fail(new AssetNotReady({ body }));
    }
    return body;
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof AssetNotReady,
      schedule: Schedule.max([
        Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("3 seconds"),
        ]),
        Schedule.recurs(20),
      ]),
    }),
  );

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Railway.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
  stage: "test",
});

// The first deploy runs the full Next.js + Node build AND creates a
// Railway deployment (~5-10 minutes), so give the hook far more
// headroom than the default 120s.
const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
  timeout: 600_000,
});
// Deleting the Railway deployment takes several minutes too.
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 600_000,
});

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a url");
  return String(url).replace(/\/+$/, "");
});

test(
  "deploys and exposes a url",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeString();
  }),
  { timeout: 180_000 },
);

test(
  "serves the server-rendered home page",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    expect(html).toContain("Next.js on Railway");
    // The `GREETING` env value from alchemy.run.ts, read via
    // `process.env` in the force-dynamic page — proves the Railway Service
    // rendered it at request time.
    expect(html).toContain("Hello from Next.js on Railway!");
  }),
  { timeout: 180_000 },
);

test(
  "serves the dynamic API route",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/api/hello`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { hello: string };
    expect(body.hello).toBe("world");
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind via postcss",
  Effect.gen(function* () {
    const url = yield* base;
    // The page markup uses Tailwind utilities — proving the project's own
    // postcss.config.mjs (@tailwindcss/postcss) ran inside `next build`.
    const html = yield* getBodyWhenReady(url, "text-3xl");
    expect(html).toContain("text-3xl");

    // Next.js links the compiled stylesheet from under /_next/static/
    // (chunks/*.css as of Next 16).
    const match = html.match(/\/_next\/static\/[^"']+\.css/);
    expect(match).not.toBeNull();

    // The stylesheet must contain the compiled Tailwind rule, not just the
    // class name in markup.
    const css = yield* getBodyWhenReady(`${url}${match![0]}`, ".text-3xl");
    expect(css).toContain(".text-3xl");
    expect(css).toContain(".font-bold");
  }),
  { timeout: 180_000 },
);

test(
  "serves a static asset from public/",
  Effect.gen(function* () {
    const url = yield* base;
    const body = yield* getBodyWhenReady(`${url}/robots.txt`, "User-agent: *");
    expect(body).toContain("User-agent: *");
  }),
  { timeout: 180_000 },
);

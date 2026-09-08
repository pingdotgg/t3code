import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

// A fresh Fly deployment (and the Fly Machine behind it) can serve
// transient 404/5xx responses while it propagates. `Test.getWhenReady`
// fails on that cold-start window and retries until the site serves a
// real response.
const { getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// While the asset manifest and Fly edge caches are still
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
  providers: Fly.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
  stage: "test",
});

// The first deploy runs the full SolidStart (vite/nitro) build AND
// creates a Fly deployment (~5-10 minutes), so give the hook far more
// headroom than the default 120s.
const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
  timeout: 600_000,
});
// Deleting the Fly deployment takes several minutes too.
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
    // The `GREETING` env value from alchemy.run.ts, read via
    // `process.env` in the index route — proves the Fly Machine rendered
    // it at request time.
    expect(html).toContain("Hello from SolidStart on Fly!");
    expect(html).toContain("Styled with Tailwind CSS");
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind from vite.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(url, "text-3xl");

    // SolidStart emits `href` before `rel`, so match attribute-order-
    // agnostically and collect every stylesheet link.
    const hrefs = [...html.matchAll(/<link\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => /rel="stylesheet"/.test(tag))
      .map((tag) => tag.match(/href="([^"]+)"/)?.[1])
      .filter((href): href is string => !!href);
    expect(hrefs.length).toBeGreaterThan(0);

    const stylesheets = yield* Effect.all(
      hrefs.map((href) =>
        Effect.gen(function* () {
          const cssUrl = href.startsWith("http")
            ? href
            : `${url}${href.startsWith("/") ? "" : "/"}${href}`;
          const res = yield* getWhenReady(cssUrl);
          expect(res.status).toBe(200);
          return yield* res.text;
        }),
      ),
    );
    expect(stylesheets.some((css) => css.includes(".text-3xl"))).toBe(true);
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

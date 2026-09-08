import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

// Fresh `workers.dev` URLs transiently 404 while the route propagates.
// `Test.getWhenReady` fails on that cold-start window and retries until the
// worker serves a real response.
const { getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// While the static-asset manifest is still propagating, Cloudflare can serve
// placeholder content with a 200 — the status alone can't distinguish "not
// yet" from "served", so retry until the body matches.
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
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

// The first deploy runs the full Vite build, so give the hook more headroom
// than the default 120s.
const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
  timeout: 600_000,
});
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a workers.dev url");
  return url.replace(/\/+$/, "");
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
  "serves the SPA index",
  Effect.gen(function* () {
    const url = yield* base;
    // The Vue app is a client-rendered SPA: the served HTML is the built
    // index.html with the app mount point and hashed asset links.
    const html = yield* getBodyWhenReady(url, '<div id="app">');
    expect(html).toContain('<div id="app">');
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind from vite.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(url, '<div id="app">');

    // In an SPA the utility classes live in the JS bundle, not the HTML, so
    // the proof that the @tailwindcss/vite plugin from the project's own
    // vite.config.ts ran is the compiled rule in the linked stylesheet.
    const link = html.match(
      /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/,
    );
    expect(link).not.toBeNull();
    const href = link![1]!;
    const cssUrl = href.startsWith("http")
      ? href
      : `${url}${href.startsWith("/") ? "" : "/"}${href}`;
    const css = yield* getBodyWhenReady(cssUrl, ".text-3xl");
    expect(css).toContain(".text-3xl");
  }),
  { timeout: 180_000 },
);

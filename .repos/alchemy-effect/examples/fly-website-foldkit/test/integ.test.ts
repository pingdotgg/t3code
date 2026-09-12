import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

// A fresh Fly deployment can serve transient 404/5xx responses
// while it propagates. `Test.getWhenReady` fails on that cold-start
// window and retries until the site serves a real response.
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

// The first deploy runs the full Vite build AND creates a Fly
// distribution (~5-10 minutes), so give the hook far more headroom than
// the default 120s.
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

// Resolve an asset href from index.html against the site base.
const resolve = (baseUrl: string, href: string) =>
  href.startsWith("http")
    ? href
    : `${baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;

test(
  "deploys and exposes a url",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeString();
  }),
  { timeout: 180_000 },
);

test(
  "serves the index HTML",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(url, '<div id="root">');
    expect(html).toContain("<title>Foldkit on Fly</title>");
  }),
  { timeout: 180_000 },
);

test(
  "ships the Foldkit app in the client bundle",
  Effect.gen(function* () {
    const url = yield* base;
    // Client-only SPA: the greeting and card view render in the browser, so
    // assert on the built JS bundle Vite links from index.html.
    const html = yield* getBodyWhenReady(url, '<script type="module"');
    const script = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/);
    expect(script).not.toBeNull();
    const js = yield* getBodyWhenReady(
      resolve(url, script![1]!),
      "Hello from Foldkit!",
    );
    expect(js).toContain("Hello from Foldkit!");
    expect(js).toContain("Styled with Tailwind CSS");
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind from vite.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    // Assert on the compiled stylesheet Vite links from index.html — the
    // compiled rule for a utility used in src/main.ts only exists if the
    // @tailwindcss/vite plugin from the project's own vite.config.ts ran.
    const html = yield* getBodyWhenReady(url, "stylesheet");
    const link = html.match(
      /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/,
    );
    expect(link).not.toBeNull();
    const css = yield* getBodyWhenReady(resolve(url, link![1]!), ".text-3xl");
    expect(css).toContain(".text-3xl");
  }),
  { timeout: 180_000 },
);

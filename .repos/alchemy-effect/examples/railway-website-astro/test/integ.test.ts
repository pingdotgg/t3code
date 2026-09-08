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

// The first deploy runs the full Astro build AND creates a Railway
// distribution (~5-10 minutes), so give the hook far more headroom than
// the default 120s.
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
    // The `GREETING` env value from alchemy.run.ts, read via
    // `process.env` in the page frontmatter — proves the Railway Service
    // rendered it at request time.
    expect(html).toContain("Hello from Astro on Railway!");
    expect(html).toContain("server-rendered in a Railway Service");
  }),
  { timeout: 180_000 },
);

test(
  "serves the prerendered about page",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/about/`);
    expect(res.status).toBe(200);
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind from astro.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    // The utility class in the markup proves the page shipped with Tailwind
    // classes; wait until the deployed HTML includes it.
    const html = yield* getBodyWhenReady(url, "text-3xl");

    // Astro either links an external compiled stylesheet or inlines small
    // ones as a <style> block — accept both, but the compiled rule for the
    // utility must be served either way. That rule only exists if the
    // @tailwindcss/vite plugin from the project's own astro.config.ts ran.
    const link = html.match(
      /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/,
    );
    if (link) {
      const href = link[1]!;
      const cssUrl = href.startsWith("http")
        ? href
        : `${url}${href.startsWith("/") ? "" : "/"}${href}`;
      const css = yield* getBodyWhenReady(cssUrl, ".text-3xl");
      expect(css).toContain(".text-3xl");
    } else {
      const style = html.match(/<style[^>]*>([\s\S]*?)<\/style>/);
      expect(style).not.toBeNull();
      expect(style![1]).toContain(".text-3xl");
    }
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

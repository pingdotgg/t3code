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

// The first deploy runs the full SolidStart (vite/nitro) build, so give the
// hook more headroom than the default 120s.
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
  "serves the server-rendered home page",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    // SolidStart server-renders the index route in the Cloudflare Worker;
    // the `GREETING` env value from alchemy.run.ts reaches it via
    // `process.env` (populated by the `nodejs_compat` flag).
    expect(html).toContain("Hello from SolidStart on Cloudflare!");
    expect(html).toContain("Styled with Tailwind CSS");
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind from vite.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    // The utility class in the markup proves the page shipped with Tailwind
    // classes; wait until the deployed HTML includes it.
    const html = yield* getBodyWhenReady(url, "text-3xl");

    // The compiled rule for the utility must be served from one of the
    // linked stylesheets — it only exists if the @tailwindcss/vite plugin
    // from the project's own vite.config.ts ran during the build.
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

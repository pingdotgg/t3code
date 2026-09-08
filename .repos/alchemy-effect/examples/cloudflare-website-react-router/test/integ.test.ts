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

// While the static-asset manifest is still propagating, Cloudflare serves a
// managed "content signals" robots.txt with a 200 — the status alone can't
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
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

// The first deploy runs the full RSC build, so give the hook more headroom
// than the default 120s.
const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
  timeout: 600_000,
});
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a workers.dev url");
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
    // `process.env` in the server component — proves the Worker rendered
    // it at request time.
    expect(html).toContain("Hello from React Router on Cloudflare!");
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

    // The RSC plugin links the compiled stylesheet from the server-rendered
    // document. The compiled rule for the utility only exists if the
    // @tailwindcss/vite plugin from the project's own vite.config.ts ran.
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
  "renders through the ssr environment's chunk",
  Effect.gen(function* () {
    const url = yield* base;
    // /worker-render loads `worker-ssr` from the `ssr` environment via
    // `import.meta.viteRsc.loadModule` — proves the `children: ["ssr"]`
    // chunks resolve inside the deployed Worker.
    const body = yield* getBodyWhenReady(`${url}/worker-render`, '"ok":true');
    expect(body).toContain("Worker render via the ssr environment.");
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

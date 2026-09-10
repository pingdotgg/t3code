import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

// Fresh `workers.dev` URLs transiently 404 while the route propagates.
// `Test.getWhenReady` fails on that cold-start window and retries until the
// worker serves a real response.
const { getWhenReady } = Test;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

// The first deploy runs the full Waku build, so give the hook more headroom
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
  "serves the server-rendered home page",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    // The `GREETING` env value from alchemy.run.ts, read via `getEnv` in the
    // dynamic RSC page — proves the Worker rendered it at request time.
    expect(html).toContain("Hello from Waku on Cloudflare!");
    expect(html).toContain(
      "This page is rendered by the Worker on every request.",
    );
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind from waku.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    // The utility class from src/pages/index.tsx made it into the markup.
    expect(html).toContain("text-3xl");

    // Locate the emitted stylesheet. Waku links the compiled CSS bundle in
    // the document head; the @tailwindcss/vite plugin registered via
    // waku.config.ts's `vite` field is what compiles it.
    const links = [...html.matchAll(/<link\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => /rel="stylesheet"/.test(tag))
      .map((tag) => /href="([^"]+)"/.exec(tag)?.[1])
      .filter((href): href is string => !!href);
    expect(links.length).toBeGreaterThan(0);

    let compiled = "";
    for (const href of links) {
      const cssUrl = href.startsWith("http")
        ? href
        : `${url}${href.startsWith("/") ? "" : "/"}${href}`;
      const cssRes = yield* getWhenReady(cssUrl);
      expect(cssRes.status).toBe(200);
      compiled += yield* cssRes.text;
    }
    // The compiled rule proves tailwind ran through the plugin from
    // waku.config.ts — not just that the class name appears in markup.
    expect(compiled).toContain(".text-3xl");
    expect(compiled).toContain("font-bold");
  }),
  { timeout: 180_000 },
);

test(
  "serves a static asset from public/",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/hello.txt`);
    expect(res.status).toBe(200);
    expect(yield* res.text).toContain("hello from public/");
  }),
  { timeout: 180_000 },
);

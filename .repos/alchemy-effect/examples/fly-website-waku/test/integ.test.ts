import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

// A fresh Fly deployment (and the Fly Machine behind it) can serve
// transient 404/5xx responses while it propagates. `Test.getWhenReady`
// fails on that cold-start window and retries until the site serves a
// real response.
const { getWhenReady } = Test;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Fly.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
  stage: "test",
});

// The first deploy runs the full Waku build AND creates a Fly
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
    // dynamic RSC page — proves the Fly Machine rendered it at request time.
    expect(html).toContain("Hello from Waku on Fly!");
    expect(html).toContain(
      "This page is rendered by the server on every request.",
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

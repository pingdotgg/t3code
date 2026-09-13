import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// While the static-asset manifest is still propagating, Cloudflare can serve
// placeholder content with a 200 — the status alone can't distinguish
// "not yet" from "served", so retry until the body matches.
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

// The point of the example: the document carries the page. A client-only
// deployment would answer with an empty `<div id="root">` here.
test(
  "serves markup rendered at the edge",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(url, 'id="count"');
    expect(html).toContain(">0<");
    // The title comes from the rendered Document, not from index.html.
    expect(html).toContain("<title>Counter: 0</title>");
  }),
  { timeout: 180_000 },
);

// Flags are derived from the request, so a different request renders a
// different page before any JavaScript runs.
test(
  "renders request-derived flags",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(`${url}/?count=7`, 'id="count"');
    expect(html).toContain(">7<");
    expect(html).toContain("<title>Counter: 7</title>");
  }),
  { timeout: 180_000 },
);

// Hydration compares the stamp before adopting any DOM, so a render without
// one is a page no client can take over.
test(
  "stamps the handoff the client hydrates against",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(url, "data-foldkit-app");
    expect(html).toContain("data-foldkit-build");
    // The Flags the server used ride along for the client to decode.
    expect(html).toContain("data-foldkit-flags");
  }),
  { timeout: 180_000 },
);

// A deep link has no file of its own, so it must reach the Worker and be
// rendered — not be answered by the asset layer with the template.
test(
  "renders a path that matches no file",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(`${url}/anything`, 'id="count"');
    expect(html).toContain("data-foldkit-app");
  }),
  { timeout: 180_000 },
);

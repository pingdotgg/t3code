import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import { describe, expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { spawnSync } from "node:child_process";
import Stack from "../alchemy.run.ts";

// A fresh Cloud Run revision can answer transient 404/5xx responses while
// its URL starts serving. `Test.getWhenReady` retries through that
// cold-start window until the site serves a real response.
const { getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// Retry until the body matches — the status alone can't distinguish a
// cold start from a served page.
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
  providers: GCP.providers(),
  state: Alchemy.localState(),
});

// The image is built locally, so the whole suite needs Docker.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status ===
  0;

describe.skipIf(!dockerAvailable)("gcp-website-nextjs", () => {
  // The first deploy runs `next build`, builds and pushes the image
  // (installing `next` into it), and rolls out Cloud Run.
  const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
    timeout: 1_200_000,
  });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: 600_000,
  });

  const base = Effect.map(stack, ({ url }) => {
    if (!url) throw new Error("expected the site to expose a Cloud Run url");
    return String(url).replace(/\/+$/, "");
  });

  test(
    "deploys and exposes a Cloud Run url",
    Effect.gen(function* () {
      const { url } = yield* stack;
      expect(String(url)).toMatch(/^https:\/\/.+\.run\.app\/?$/);
    }),
    { timeout: 180_000 },
  );

  test(
    "serves the server-rendered home page",
    Effect.gen(function* () {
      const url = yield* base;
      const html = yield* getBodyWhenReady(url, "Next.js on Cloud Run");
      // The `GREETING` env value from alchemy.run.ts, read via
      // `process.env` in the force-dynamic page — proves the container
      // rendered it at request time.
      expect(html).toContain("Hello from Next.js on Cloud Run!");
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
      const match = html.match(/\/_next\/static\/[^"']+\.css/);
      expect(match).not.toBeNull();
      const css = yield* getBodyWhenReady(`${url}${match![0]}`, ".text-3xl");
      expect(css).toContain(".font-bold");
    }),
    { timeout: 180_000 },
  );

  test(
    "serves a static asset from public/",
    Effect.gen(function* () {
      const url = yield* base;
      const body = yield* getBodyWhenReady(
        `${url}/robots.txt`,
        "User-agent: *",
      );
      expect(body).toContain("User-agent: *");
    }),
    { timeout: 180_000 },
  );
});

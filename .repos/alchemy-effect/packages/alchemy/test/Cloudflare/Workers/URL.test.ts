import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import Stack from "./fixtures/url-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Fresh workers.dev URLs can briefly serve Cloudflare's placeholder page with
// a 200, so retry until the body parses as JSON (the placeholder is HTML).
const getJson = (url: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(url)),
    Effect.flatMap((res) => res.json),
    Effect.retry({
      schedule: Schedule.exponential("1 second"),
      times: 12,
    }),
    Effect.map((body) => body as Record<string, string>),
  );

test(
  "effectful worker reads its own URL via yield* Worker.URL",
  Effect.gen(function* () {
    const { effectUrl } = yield* stack;
    const body = yield* getJson(`${effectUrl}/`);
    expect(body.url).toBe(effectUrl);
  }),
  { timeout: 180_000 },
);

test(
  "async worker receives its own URL via env: { PUBLIC_URL: Worker.URL }",
  Effect.gen(function* () {
    const { asyncUrl } = yield* stack;
    const body = yield* getJson(`${asyncUrl}/`);
    expect(body.url).toBe(asyncUrl);
  }),
  { timeout: 180_000 },
);

// The canonical VITE_PUBLIC_URL use case: the URL is resolved before the vite
// build, so it reaches the bundle two ways — inlined into `import.meta.env`
// via `define` at build time, and as a plain_text env binding at deploy time.
test.provider.skipIf(!!process.env.FAST)(
  "vite worker inlines VITE_PUBLIC_URL at build time and binds it at runtime",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = pathe.resolve(
        import.meta.dirname,
        "fixtures/vite-url-fixture",
      );
      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("UrlViteWorker", {
            vite: {
              rootDir,
              memo: {
                include: [
                  "index.html",
                  "package.json",
                  "vite.config.ts",
                  "src/**",
                ],
              },
            },
            compatibility: {
              date: "2024-09-23",
              flags: ["nodejs_compat"],
            },
            env: {
              VITE_PUBLIC_URL: Cloudflare.Worker.URL,
            },
          });
        }),
      );

      expect(site.url).toBeDefined();
      const body = yield* getJson(`${site.url!}/self-url`);
      expect(body.inlined).toBe(site.url);
      expect(body.env).toBe(site.url);

      yield* stack.destroy();
    }),
  { timeout: 360_000 },
);

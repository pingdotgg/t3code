import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

/**
 * Fetch a URL, retrying until the worker serves a 200 (fresh dev workers can
 * briefly 503 while workerd boots; the first browser request may also launch
 * Chrome). Non-200s carry the body so a persistent fixture error surfaces.
 */
const getReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : res.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(new WorkerNotReady({ status: res.status, body })),
              ),
            ),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
  }).pipe(Effect.orDie);

const fixtureMain = pathe.resolve(
  import.meta.dirname,
  "fixtures/browser-local-worker.ts",
);

/**
 * Under `alchemy dev` the `browser` binding is emulated by cloudflare-runtime:
 * a real headless Chrome is launched on this machine (downloaded on first use
 * into the shared wrangler cache) and the Browser Rendering session protocol
 * is proxied to its CDP endpoint. `@cloudflare/puppeteer` drives it exactly
 * like the real service — no Cloudflare credentials or preview session are
 * involved for the binding.
 */
test.provider(
  "browser binding round-trips against the local Chrome simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("browser-local-worker", {
            main: fixtureMain,
            compatibility: { flags: ["nodejs_compat"] },
            env: { BROWSER: Cloudflare.Browser("BROWSER") },
          });
          return { url: worker.url.as<string>() };
        }),
      );

      // Served from the local dev proxy — proof the worker runs locally.
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      // Render an inline page through puppeteer over the emulated binding.
      // The first request may download Chrome, so it gets a long retry rope.
      const titleRes = yield* getReady(`${deployed.url}/title`);
      const body = (yield* titleRes.json) as {
        title: string;
        heading: string;
      };
      expect(body.title).toBe("Local Browser Test");
      expect(body.heading).toBe("Hello from the local browser");

      // A screenshot of the same page is a real PNG (magic bytes).
      const shotRes = yield* getReady(`${deployed.url}/screenshot`);
      const bytes = new Uint8Array(yield* shotRes.arrayBuffer);
      expect(bytes.length).toBeGreaterThan(1000);
      expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

/**
 * `Alchemy.remote()` opts the binding OUT of local emulation: the
 * locally-served worker drives the real Browser Rendering service through
 * the remote-bindings preview session. The live suite
 * (test/Cloudflare/Browser/Browser.test.ts) covers deployed-binding
 * behavior; this leg pins the dev-mode remote lowering path.
 */
test.provider(
  "Alchemy.remote() proxies the binding to the real Browser Rendering service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("browser-remote-worker", {
            main: fixtureMain,
            compatibility: { flags: ["nodejs_compat"] },
            env: {
              BROWSER: Cloudflare.Browser("BROWSER").pipe(Alchemy.remote()),
            },
          });
          return { url: worker.url.as<string>() };
        }),
      );

      // Still served locally — only the binding is remote.
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      const titleRes = yield* getReady(`${deployed.url}/title`);
      const body = (yield* titleRes.json) as { title: string };
      expect(body.title).toBe("Local Browser Test");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

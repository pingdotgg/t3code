import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "vite-fixture");

// Vite/Rollup's `vite:build-html` plugin chokes when the project root
// is outside the current working directory because it tries to express
// the emitted asset path relative to `cwd`. To keep the temp clone
// reachable via a sane relative path, allocate the temp dir *inside*
// the alchemy package's `.tmp/` so it sits under the same workspace
// root as `cwd`.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

test.provider(
  "Vite: editing a source file republishes the assets in a single deploy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vite-fix-",
        tempRoot,
        entries: ["index.html", "package.json", "vite.config.ts", "src"],
      });
      const indexPath = path.join(rootDir, "index.html");

      // Restrict the input memo to fixture sources so the test isn't
      // re-hashing the whole monorepo on every deploy.
      const memoInclude = ["index.html", "src/**", "package.json"];

      const v1Marker = `vite-v1-${Date.now()}`;
      yield* fs.writeFileString(indexPath, htmlPage(v1Marker));

      const site1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Vite(
            "FixVite",
            viteProps(rootDir, memoInclude),
          );
        }),
      );

      expect(site1.url).toBeDefined();
      expect(site1.hash?.input).toBeDefined();
      yield* expectWorkerExists(site1.workerName, accountId);
      yield* expectUrlContains(`${site1.url!}/`, v1Marker, {
        timeout: "120 seconds",
        label: "deploy1 v1 marker",
      });

      // ── deploy 2: edit fixture, redeploy once ──────────────────────────
      const v2Marker = `vite-v2-${Date.now()}`;
      yield* fs.writeFileString(indexPath, htmlPage(v2Marker));

      const site2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Vite(
            "FixVite",
            viteProps(rootDir, memoInclude),
          );
        }),
      );

      expect(site2.hash?.input).toBeDefined();
      expect(site2.hash?.input).not.toEqual(site1.hash?.input);
      yield* expectUrlContains(`${site2.url!}/`, v2Marker, {
        timeout: "60 seconds",
        label: "deploy2 v2 marker",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

// ─────────────────────────────────────────────────────────────────────
// Path-relocation behavior for the vite path
//
// `Cloudflare.Vite` hashes its memo'd input tree (`hash.input`)
// instead of carrying an `AssetsWithHash`. The diff is:
//
//   `input !== output.hash?.input`
//
// — a pure content comparison that must be stable across rootDir
// moves. We delete the original rootDir between deploys to make the
// test fail loudly if anything still depends on the recorded path.
// ─────────────────────────────────────────────────────────────────────

test.provider(
  "Vite: relocating rootDir (and deleting the old one) is a no-op when sources are identical",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const memoInclude = ["index.html", "src/**", "package.json"];
      const marker = `vite-relocate-${Date.now()}`;

      const rootA = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vite-relocate-a-",
        tempRoot,
        entries: ["index.html", "package.json", "vite.config.ts", "src"],
      });
      yield* fs.writeFileString(
        path.join(rootA, "index.html"),
        htmlPage(marker),
      );

      const site1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Vite(
            "ViteReloc",
            viteProps(rootA, memoInclude),
          );
        }),
      );
      expect(site1.hash?.input).toBeDefined();
      yield* expectUrlContains(`${site1.url!}/`, marker, {
        timeout: "120 seconds",
        label: "deploy1 marker",
      });

      // Drop rootA so a stale path comparison can't quietly succeed.
      yield* fs.remove(rootA, { recursive: true });

      const rootB = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vite-relocate-b-",
        tempRoot,
        entries: ["index.html", "package.json", "vite.config.ts", "src"],
      });
      yield* fs.writeFileString(
        path.join(rootB, "index.html"),
        htmlPage(marker),
      );

      const site2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Vite(
            "ViteReloc",
            viteProps(rootB, memoInclude),
          );
        }),
      );

      // Identical sources ⇒ identical input hash ⇒ diff says
      // unchanged ⇒ no rebuild required for the apply to succeed.
      expect(site2.hash?.input).toEqual(site1.hash?.input);
      yield* expectUrlContains(`${site2.url!}/`, marker, {
        timeout: "60 seconds",
        label: "deploy2 marker",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

test.provider(
  "Vite: `env` props are inlined as `import.meta.env.*` into the bundle",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vite-env-",
        tempRoot,
        entries: ["index.html", "package.json", "vite.config.ts", "src"],
      });
      const memoInclude = ["index.html", "src/**", "package.json"];
      const marker = `vite-env-${Date.now()}`;

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Vite("FixViteEnv", {
            ...viteProps(rootDir, memoInclude),
            env: { VITE_TEST_MARKER: marker },
          });
        }),
      );

      expect(site.url).toBeDefined();
      // Resolve the hashed bundle URL by reading the deployed HTML, then
      // assert the marker that `main.ts` references via
      // `import.meta.env.VITE_TEST_MARKER` was actually inlined into the
      // served JS asset by `Cloudflare.Vite`'s `env`-→-`define` plumbing.
      const bundleUrl = yield* discoverBundleUrl(site.url!);
      yield* expectUrlContains(bundleUrl, marker, {
        timeout: "60 seconds",
        label: "VITE_TEST_MARKER inlined into client bundle",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

const discoverBundleUrl = (siteUrl: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    return yield* Effect.gen(function* () {
      const res = yield* client.get(`${siteUrl}/`);
      const html = yield* res.text;
      const match = html.match(
        /<script[^>]+src="(\/assets\/[^"]+\.js)"[^>]*>/i,
      );
      if (!match) {
        // Fresh deploys can briefly return Cloudflare's "There is
        // nothing here yet" HTML page instead of the SPA index — retry.
        return yield* Effect.fail(
          new Error(
            `Could not find /assets/*.js script tag in HTML: ${html.slice(0, 200)}`,
          ),
        );
      }
      return `${siteUrl}${match[1]}`;
    }).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
  });

const viteProps = (rootDir: string, memoInclude: string[]) => ({
  rootDir,
  url: true as const,
  subdomain: { enabled: true, previewsEnabled: true },
  compatibility: {
    date: "2024-09-23",
    flags: ["nodejs_compat"],
  },
  memo: { include: memoInclude },
});

const htmlPage = (marker: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${marker}</title>
  </head>
  <body>
    <div id="app">${marker}</div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;

import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";
import type { Counter as ViteDoCounter } from "./vite-do-fixture/src/worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });
const { test: devTest } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "vite-fixture");
const spaFixtureDir = pathe.resolve(import.meta.dirname, "vite-spa-fixture");
const doFixtureDir = pathe.resolve(import.meta.dirname, "vite-do-fixture");
const reactRouterRscFixtureDir = pathe.resolve(
  import.meta.dirname,
  "react-router-rsc-fixture",
);
const tanstackDevBindingsFixtureDir = pathe.resolve(
  import.meta.dirname,
  "tanstack-dev-bindings-fixture",
);

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
      const { accountId } = yield* yield* CloudflareEnvironment;
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
      const memoInclude = [
        "index.html",
        "src/**",
        "package.json",
        "vite.config.ts",
      ];

      const v1Marker = `vite-v1-${Date.now()}`;
      yield* fs.writeFileString(indexPath, htmlPage(v1Marker));

      const site1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Vite(
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
          return yield* Cloudflare.Website.Vite(
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

// Regression test for https://github.com/alchemy-run/alchemy/issues/792.
//
// A pure client-only Vite project (no vite.config.ts, no plugins, no worker
// entry) resolves as `appType: "spa"`, so the Cloudflare Vite plugin declares
// no `builder.buildApp`. On Vite 8, `builder.buildApp()` then runs post-order
// `buildApp` hooks *before* the default environment builds — which used to make
// our build-output plugin resolve while the client output was still undefined,
// so the deploy died with "Vite build produced neither assets nor server
// output". Detecting completion in `writeBundle` (per environment) instead of a
// post-order `buildApp` hook fixes it; this test proves the SPA path deploys.
test.provider(
  "Vite: client-only SPA (no config, no plugins) builds and serves assets",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(spaFixtureDir, {
        prefix: "alchemy-vite-spa-",
        tempRoot,
        entries: ["index.html", "package.json", "src"],
      });
      const indexPath = path.join(rootDir, "index.html");
      const memoInclude = ["index.html", "src/**", "package.json"];

      const marker = `vite-spa-${Date.now()}`;
      yield* fs.writeFileString(indexPath, htmlPage(marker));

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Vite(
            "FixViteSpa",
            viteProps(rootDir, memoInclude),
          );
        }),
      );

      expect(site.url).toBeDefined();
      expect(site.hash?.input).toBeDefined();
      yield* expectWorkerExists(site.workerName, accountId);
      yield* expectUrlContains(`${site.url!}/`, marker, {
        timeout: "120 seconds",
        label: "spa marker",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

test.provider(
  "Vite: class form deploys and serves the built assets",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vite-class-",
        tempRoot,
        entries: ["index.html", "package.json", "vite.config.ts", "src"],
      });
      const indexPath = path.join(rootDir, "index.html");
      const memoInclude = [
        "index.html",
        "src/**",
        "package.json",
        "vite.config.ts",
      ];

      const marker = `vite-class-${Date.now()}`;
      yield* fs.writeFileString(indexPath, htmlPage(marker));

      const site1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* class FixVite extends Cloudflare.Website.Vite<FixVite>()(
            "FixVite",
            viteProps(rootDir, memoInclude),
          ) {};
        }),
      );

      expect(site1.url).toBeDefined();
      expect(site1.hash?.input).toBeDefined();
      yield* expectWorkerExists(site1.workerName, accountId);
      yield* expectUrlContains(`${site1.url!}/`, marker, {
        timeout: "120 seconds",
        label: "class form marker",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

// ─────────────────────────────────────────────────────────────────────
// Path-relocation behavior for the vite path
//
// `Cloudflare.Website.Vite` stores a path-insensitive `hash.input` made from
// the memo'd input tree plus build-affecting Vite options. The diff is:
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
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const memoInclude = [
        "index.html",
        "src/**",
        "package.json",
        "vite.config.ts",
      ];
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
          return yield* Cloudflare.Website.Vite(
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
          return yield* Cloudflare.Website.Vite(
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

// ─────────────────────────────────────────────────────────────────────
// Workspace-aware memoization
//
// A Vite project in a monorepo can bundle source from sibling workspace
// packages. Those directories are discovered from the module graph at
// build time, persisted in `hash.workspaces` (relative to the Vite
// root), and included in the `hash.input` computation — so editing only
// a sibling package busts the memo and triggers a rebuild.
// ─────────────────────────────────────────────────────────────────────

test.provider(
  "Vite: edits in a sibling workspace package bust the build memo",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      // Hand-rolled two-package workspace: `app` is the Vite root and
      // `shared` is a sibling package whose source the client bundle
      // imports directly (escaping the Vite root).
      yield* fs.makeDirectory(tempRoot, { recursive: true });
      const parent = yield* fs.makeTempDirectory({
        prefix: "alchemy-vite-ws-",
        directory: tempRoot,
      });
      yield* Effect.addFinalizer(
        Exit.match({
          onSuccess: () =>
            Effect.ignore(fs.remove(parent, { recursive: true })),
          onFailure: () => Effect.void,
        }),
      );
      const rootDir = path.join(parent, "app");
      const sharedDir = path.join(parent, "shared");

      const writeShared = (marker: string) =>
        fs.writeFileString(
          path.join(sharedDir, "src/message.ts"),
          `export const message = ${JSON.stringify(marker)};\n`,
        );

      yield* fs.makeDirectory(path.join(rootDir, "src"), { recursive: true });
      yield* fs.makeDirectory(path.join(sharedDir, "src"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(rootDir, "index.html"),
        htmlPage("vite-workspace-fixture"),
      );
      yield* fs.writeFileString(
        path.join(rootDir, "package.json"),
        JSON.stringify({
          name: "alchemy-vite-workspace-app",
          version: "0.0.0",
          private: true,
          type: "module",
        }),
      );
      // Same shape as vite-fixture/vite.config.ts: point the SSR build at
      // the minimal worker entry so the cloudflare-vite-plugin can wrap it.
      yield* fs.writeFileString(
        path.join(rootDir, "vite.config.ts"),
        `import { defineConfig } from "vite";
export default defineConfig({
  environments: {
    ssr: { build: { rollupOptions: { input: "./src/worker.ts" } } },
  },
});
`,
      );
      yield* fs.writeFileString(
        path.join(rootDir, "src/worker.ts"),
        `type Env = { ASSETS: { fetch: (req: Request) => Promise<Response> } };
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
};
`,
      );
      // The client entry imports across the Vite root boundary into the
      // sibling package's source.
      yield* fs.writeFileString(
        path.join(rootDir, "src/main.ts"),
        `import { message } from "../../shared/src/message.ts";
const el = document.getElementById("app");
if (el) {
  el.textContent = message;
}
`,
      );
      yield* fs.writeFileString(
        path.join(sharedDir, "package.json"),
        JSON.stringify({
          name: "alchemy-vite-workspace-shared",
          version: "0.0.0",
          private: true,
          type: "module",
        }),
      );

      const memoInclude = [
        "index.html",
        "src/**",
        "package.json",
        "vite.config.ts",
      ];

      const marker1 = `vite-ws-1-${Date.now()}`;
      yield* writeShared(marker1);

      const site1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Vite(
            "ViteWorkspace",
            viteProps(rootDir, memoInclude),
          );
        }),
      );

      expect(site1.url).toBeDefined();
      expect(site1.hash?.input).toBeDefined();
      // The sibling package was discovered from the module graph and
      // persisted relative to the Vite root.
      expect(site1.hash?.additionalWorkspaces).toContain("../shared");
      yield* expectWorkerExists(site1.workerName, accountId);
      yield* expectBundleContains(site1.url!, marker1, {
        label: "workspace marker v1 in client bundle",
      });

      // ── deploy 2: edit ONLY the sibling package ────────────────────────
      const marker2 = `vite-ws-2-${Date.now()}`;
      yield* writeShared(marker2);

      const site2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Vite(
            "ViteWorkspace",
            viteProps(rootDir, memoInclude),
          );
        }),
      );

      // Nothing under `rootDir` changed — only the sibling workspace did.
      // The workspace-aware input hash must still bust the memo.
      expect(site2.hash?.input).toBeDefined();
      expect(site2.hash?.input).not.toEqual(site1.hash?.input);
      expect(site2.hash?.additionalWorkspaces).toContain("../shared");
      yield* expectBundleContains(site2.url!, marker2, {
        label: "workspace marker v2 in client bundle",
      });

      // ── deploy 3: no changes anywhere ⇒ memo hit ───────────────────────
      const site3 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Vite(
            "ViteWorkspace",
            viteProps(rootDir, memoInclude),
          );
        }),
      );

      expect(site3.hash?.input).toEqual(site2.hash?.input);
      expect(site3.hash?.additionalWorkspaces).toEqual(
        site2.hash?.additionalWorkspaces,
      );

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

test.provider(
  "Vite: `env` props are inlined and env-only changes redeploy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-vite-env-",
        tempRoot,
        entries: ["index.html", "package.json", "vite.config.ts", "src"],
      });
      const memoInclude = ["index.html", "src/**", "package.json"];
      const marker1 = `vite-env-1-${Date.now()}`;

      const site1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Vite("FixViteEnv", {
            ...viteProps(rootDir, memoInclude),
            env: { VITE_TEST_MARKER: marker1 },
          });
        }),
      );

      expect(site1.url).toBeDefined();
      expect(site1.hash?.input).toBeDefined();
      // Resolve the hashed bundle URL by reading the deployed HTML, then
      // assert the marker that `main.ts` references via
      // `import.meta.env.VITE_TEST_MARKER` was actually inlined into the
      // served JS asset by `Cloudflare.Website.Vite`'s `env`-→-`define` plumbing.
      yield* expectBundleContains(site1.url!, marker1, {
        label: "VITE_TEST_MARKER v1 inlined into client bundle",
      });

      const marker2 = `vite-env-2-${Date.now()}`;
      const site2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Vite("FixViteEnv", {
            ...viteProps(rootDir, memoInclude),
            env: { VITE_TEST_MARKER: marker2 },
          });
        }),
      );

      expect(site2.hash?.input).toBeDefined();
      yield* expectBundleContains(site2.url!, marker2, {
        label: "VITE_TEST_MARKER v2 inlined into client bundle",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

test.provider(
  "Vite: worker entry can host a local Durable Object binding",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(doFixtureDir, {
        prefix: "alchemy-vite-do-",
        tempRoot,
        // Keep the fixture's real stack file available for local
        // `alchemy dev` smoke tests. The live deploy below uses an inline
        // stack so cleanup stays under the provider test harness.
        entries: [
          "alchemy.run.ts",
          "index.html",
          "package.json",
          "vite.config.ts",
          "src",
        ],
      });
      const memoInclude = [
        "index.html",
        "src/**",
        "package.json",
        "vite.config.ts",
      ];

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Vite("ViteDo", {
            ...viteProps(rootDir, memoInclude),
            compatibility: {
              date: "2026-03-17",
              flags: ["nodejs_compat"],
            },
            assets: {
              runWorkerFirst: ["/api/*"],
            },
            env: {
              Counter: Cloudflare.DurableObject<ViteDoCounter>("Counter", {
                className: "Counter",
              }),
            },
          });
        }),
      );

      expect(site.url).toBeDefined();
      yield* expectWorkerExists(site.workerName, accountId);
      yield* expectUrlContains(`${site.url!}/`, "Vite DO fixture", {
        timeout: "120 seconds",
        label: "vite do fixture assets",
      });

      const reset = yield* fetchJsonReady<{ ok: boolean }>(
        `${site.url!}/api/reset`,
      );
      expect(reset.ok).toBe(true);

      const first = yield* fetchJsonReady<{ count: number }>(
        `${site.url!}/api/count`,
      );
      expect(first.count).toBe(1);

      const second = yield* fetchJsonReady<{ count: number }>(
        `${site.url!}/api/count`,
      );
      expect(second.count).toBe(2);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

test.provider(
  "Vite: main overrides the worker entry from the Vite config",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(doFixtureDir, {
        prefix: "alchemy-vite-main-",
        tempRoot,
        entries: [
          "alchemy.run.ts",
          "index.html",
          "package.json",
          "vite.config.ts",
          "src",
        ],
      });
      const memoInclude = [
        "index.html",
        "src/**",
        "package.json",
        "vite.config.ts",
      ];

      // The fixture's vite.config.ts points the ssr environment at
      // `src/worker.ts`. `main` must take precedence and deploy
      // `src/worker-main.ts`, which re-exports the Durable Object and
      // additionally answers `/api/entry`.
      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Vite("ViteMain", {
            ...viteProps(rootDir, memoInclude),
            main: "src/worker-main.ts",
            compatibility: {
              date: "2026-03-17",
              flags: ["nodejs_compat"],
            },
            assets: {
              runWorkerFirst: ["/api/*"],
            },
            env: {
              Counter: Cloudflare.DurableObject<ViteDoCounter>("Counter", {
                className: "Counter",
              }),
            },
          });
        }),
      );

      expect(site.url).toBeDefined();
      yield* expectWorkerExists(site.workerName, accountId);

      const entry = yield* fetchJsonReady<{ entry: string }>(
        `${site.url!}/api/entry`,
      );
      expect(entry.entry).toBe("worker-main");

      const reset = yield* fetchJsonReady<{ ok: boolean }>(
        `${site.url!}/api/reset`,
      );
      expect(reset.ok).toBe(true);

      const first = yield* fetchJsonReady<{ count: number }>(
        `${site.url!}/api/count`,
      );
      expect(first.count).toBe(1);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

test.provider(
  "Vite: React Router RSC deploys from a distilled manifest",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const rootDir = yield* cloneFixture(reactRouterRscFixtureDir, {
        prefix: "alchemy-vite-rsc-",
        tempRoot,
        // Keep the fixture's stack file available for local `alchemy dev`
        // smoke tests. The live deploy below uses an inline stack so cleanup
        // stays under the provider test harness.
        entries: [
          "alchemy.run.ts",
          "app",
          "package.json",
          "react-router-vite",
          "tsconfig.json",
          "vite.config.ts",
        ],
      });
      const memoInclude = [
        "app/**",
        "react-router-vite/**",
        "package.json",
        "tsconfig.json",
        "vite.config.ts",
      ];
      const compatibility = {
        date: "2026-03-10",
        flags: ["nodejs_compat"],
      };
      const assets = {
        runWorkerFirst: true,
      };
      const viteEnvironments = { entry: "rsc", children: ["ssr"] };

      const site = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Website.Vite("ReactRouterRsc", {
            ...viteProps(rootDir, memoInclude),
            assets,
            compatibility,
            viteEnvironments,
          });
        }),
      );

      expect(site.url).toBeDefined();
      yield* expectWorkerExists(site.workerName, accountId);
      yield* expectUrlContains(`${site.url!}/`, "React Router Vite", {
        timeout: "120 seconds",
        label: "react router rsc home route",
      });
      yield* expectUrlContains(`${site.url!}/about`, "About", {
        timeout: "60 seconds",
        label: "react router rsc client route",
      });

      const render = yield* fetchJsonReady<{ ok: boolean; html: string }>(
        `${site.url!}/worker-render`,
      );
      expect(render.ok).toBe(true);
      expect(render.html).toContain("Worker render via the ssr environment.");

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

devTest.provider(
  "Vite dev: TanStack Start keeps Alchemy-managed R2 bindings",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bucketNames = new Set<string>();

      const cleanup = Effect.gen(function* () {
        yield* stack.destroy();
        for (const bucketName of bucketNames) {
          yield* waitForBucketToBeDeleted(bucketName, accountId);
        }
      });

      const body = Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(tanstackDevBindingsFixtureDir, {
          prefix: "alchemy-tanstack-dev-bindings-",
          tempRoot,
          entries: [
            "alchemy.run.ts",
            "package.json",
            "tsconfig.json",
            "vite.config.ts",
            "src",
          ],
        });
        const indexRoutePath = path.join(rootDir, "src/routes/index.tsx");
        const memoInclude = [
          "src/**",
          "package.json",
          "tsconfig.json",
          "vite.config.ts",
          "alchemy.run.ts",
        ];
        const key = `dev-binding-${Date.now()}.txt`;

        yield* fs.writeFileString(
          indexRoutePath,
          tanstackIndexRouteSource("hmr-marker-v1"),
        );

        const deploy = (bucketId: string, marker: string) =>
          stack.deploy(
            Effect.gen(function* () {
              const bucket = yield* Cloudflare.R2.Bucket(bucketId);
              const worker = yield* Cloudflare.Website.Vite(
                "TanStackDevBindings",
                {
                  ...viteProps(rootDir, memoInclude),
                  assets: {
                    runWorkerFirst: true,
                  },
                  dev: {
                    port: 0,
                  },
                  env: {
                    BUCKET: bucket,
                    DEV_MARKER: marker,
                  },
                },
              );
              return { bucket, worker };
            }),
          );

        const first = yield* deploy("DevBucketA", "dev-marker-v1");
        bucketNames.add(first.bucket.bucketName);
        expect(first.worker.url).toBeDefined();
        const r2Url = (base: string) =>
          joinUrl(base, `/api/r2?key=${encodeURIComponent(key)}`);
        yield* expectUrlContains(
          joinUrl(first.worker.url!, "/"),
          "hmr-marker-v1",
          {
            timeout: "30 seconds",
            label: "tanstack dev initial route",
          },
        );

        const env1 = yield* fetchJsonReady<{ marker: string }>(
          r2Url(first.worker.url!),
        );
        expect(env1.marker).toBe("dev-marker-v1");

        const put1 = yield* putTextJsonReady<{ ok: boolean }>(
          r2Url(first.worker.url!),
          "from-a",
        );
        expect(put1.ok).toBe(true);

        const get1 = yield* fetchJsonReady<{ value: string | null }>(
          r2Url(first.worker.url!),
        );
        expect(get1.value).toBe("from-a");

        // Change only a TanStack route file. The stack is not re-applied; the
        // local Vite server should render the updated route through the same
        // Alchemy proxy.
        yield* fs.writeFileString(
          indexRoutePath,
          tanstackIndexRouteSource("hmr-marker-v2"),
        );
        yield* expectUrlContains(
          joinUrl(first.worker.url!, "/"),
          "hmr-marker-v2",
          {
            timeout: "30 seconds",
            label: "tanstack dev updated route",
          },
        );

        const second = yield* deploy("DevBucketB", "dev-marker-v2");
        bucketNames.add(second.bucket.bucketName);
        expect(second.worker.url).toBe(first.worker.url);

        const env2 = yield* fetchJsonReady<{ marker: string }>(
          r2Url(second.worker.url!),
        );
        expect(env2.marker).toBe("dev-marker-v2");

        // The Worker was rebound to DevBucketB. The object written through
        // DevBucketA should not be visible through the new binding.
        const reboundRead = yield* fetchJsonReady<{ value: string | null }>(
          r2Url(second.worker.url!),
        );
        expect(reboundRead.value).toBeNull();

        const put2 = yield* putTextJsonReady<{ ok: boolean }>(
          r2Url(second.worker.url!),
          "from-b",
        );
        expect(put2.ok).toBe(true);

        const get2 = yield* fetchJsonReady<{ value: string | null }>(
          r2Url(second.worker.url!),
        );
        expect(get2.value).toBe("from-b");
      });

      const exit = yield* Effect.exit(body);
      if (Exit.isSuccess(exit)) {
        yield* cleanup;
        return exit.value;
      }

      yield* cleanup.pipe(
        Effect.tapError((error) =>
          Effect.logError("Vite dev live test cleanup failed", error),
        ),
        Effect.ignore,
      );
      return yield* Effect.failCause(exit.cause);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

const freshConn = HttpClient.mapRequest(
  HttpClientRequest.setHeader("connection", "close"),
);

// The local dev provider returns `worker.url` from `URL#toString()`, which
// keeps a trailing slash (`http://localhost:PORT/`), whereas the cloud
// provider returns a bare origin (`https://….workers.dev`). Join without
// producing a `//` path that the dev server's router won't match.
const joinUrl = (base: string, path: string) =>
  `${base.replace(/\/+$/, "")}${path}`;

const fetchJsonReady = <T>(url: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.flatMap(res.text, (body) =>
              Effect.try({
                try: () => JSON.parse(body) as T,
                catch: () => new Error(`non-json body: ${body}`),
              }),
            )
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 15,
      }),
    );
  });

const putTextJsonReady = <T>(url: string, body: string) =>
  Effect.gen(function* () {
    return yield* HttpClient.execute(
      HttpClientRequest.put(url).pipe(
        HttpClientRequest.bodyText(body, "text/plain"),
      ),
    ).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.flatMap(res.text, (responseBody) =>
              Effect.try({
                try: () => JSON.parse(responseBody) as T,
                catch: () => new Error(`non-json body: ${responseBody}`),
              }),
            )
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 15,
      }),
    );
  });

// Assert that the site's *current* client bundle contains `marker`.
//
// The bundle filename is content-addressed, so an env-only redeploy changes
// the bundle URL referenced by `index.html`. A PoP can keep serving the
// previous deployment's `index.html` for a while after the version flip
// (cache-busting query params don't help when the whole deployment is stale
// at that edge) — so discovering the bundle URL *once* and then polling that
// asset latches onto the old, immutable bundle and times out waiting for a
// marker that will never appear there. Instead, re-discover the bundle URL
// from `index.html` on every attempt so the assertion converges as soon as
// the new deployment propagates.
const expectBundleContains = (
  siteUrl: string,
  marker: string,
  options: { label?: string } = {},
) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    yield* Effect.gen(function* () {
      // Cache-bust the index fetch — the unique query string defeats the
      // CDN cache key for caches that respect it.
      const res = yield* client.get(`${siteUrl}/`, {
        urlParams: { __alchemy_cb: String(Date.now()) },
        headers: { "cache-control": "no-cache", pragma: "no-cache" },
      });
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
      const bundleRes = yield* client.get(`${siteUrl}${match[1]}`, {
        urlParams: { __alchemy_cb: String(Date.now()) },
        headers: { "cache-control": "no-cache", pragma: "no-cache" },
      });
      const bundle = yield* bundleRes.text;
      if (!bundle.includes(marker)) {
        return yield* Effect.fail(
          new Error(
            `bundle ${match[1]} does not (yet) contain marker "${marker}"`,
          ),
        );
      }
    }).pipe(
      Effect.retry({
        // ~2 minutes total: capped exponential sampling through edge
        // propagation of both the fresh index.html and the new asset.
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis", 1.5),
            Schedule.spaced("5 seconds"),
          ]),
          Schedule.recurs(30),
        ]),
      }),
      Effect.tapError((error) =>
        Effect.logError(
          `expectBundleContains(${options.label ?? marker}) failed`,
          error,
        ),
      ),
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

const tanstackIndexRouteSource = (marker: string) => `
/** @jsxImportSource react */
import { createFileRoute } from "@tanstack/react-router";

const marker = ${JSON.stringify(marker)};

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <main>{marker}</main>;
}
`;

const waitForBucketToBeDeleted = Effect.fn(function* (
  bucketName: string,
  accountId: string,
) {
  yield* r2
    .getBucket({
      accountId,
      bucketName,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new BucketStillExists())),
      Effect.retry({
        while: (error): error is BucketStillExists =>
          error instanceof BucketStillExists,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("200 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(20),
        ]),
      }),
      Effect.catchTag("NoSuchBucket", () => Effect.void),
    );
});

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

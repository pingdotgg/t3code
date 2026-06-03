import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
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

const fixtureDir = pathe.resolve(import.meta.dirname, "staticsite-fixture");
const workerEntry = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");

test.provider(
  "StaticSite: editing a source file republishes the assets in a single deploy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const cwd = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-staticsite-fix-",
        entries: ["src", "build.sh"],
      });
      const indexPath = path.join(cwd, "src", "index.html");

      // ── deploy 1: initial publish ──────────────────────────────────────
      const v1Marker = `staticsite-v1-${Date.now()}`;
      yield* fs.writeFileString(indexPath, htmlPage(v1Marker));

      const site1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.StaticSite("FixSite", staticSiteProps(cwd));
        }),
      );

      expect(site1.url).toBeDefined();
      expect(site1.hash?.assets).toBeDefined();
      yield* expectWorkerExists(site1.workerName, accountId);
      // End-to-end: the worker URL actually serves the v1 marker.
      // Use a long timeout because workers.dev subdomains can take 60s+
      // to propagate the very first time they're enabled.
      yield* expectUrlContains(`${site1.url!}/index.html`, v1Marker, {
        timeout: "120 seconds",
        label: "deploy1 v1 marker",
      });

      // ── deploy 2: edit fixture, redeploy once ──────────────────────────
      const v2Marker = `staticsite-v2-${Date.now()}`;
      yield* fs.writeFileString(indexPath, htmlPage(v2Marker));

      const site2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.StaticSite("FixSite", staticSiteProps(cwd));
        }),
      );

      expect(site2.hash?.assets).toBeDefined();
      expect(site2.hash?.assets).not.toEqual(site1.hash?.assets);

      // The single-deploy guarantee: after one redeploy, the new
      // marker is reachable over HTTP. Before the fix, this failure
      // mode is what users were hitting — the worker version finalized
      // pointing at the previous asset manifest because the initial
      // Worker.update read dist mid-write.
      yield* expectUrlContains(`${site2.url!}/index.html`, v2Marker, {
        timeout: "60 seconds",
        label: "deploy2 v2 marker",
      });
      // And the v1 marker should be gone — i.e. the new deploy fully
      // replaced the previous content rather than coexisting with it.
      yield* expectUrlAbsent(`${site2.url!}/index.html`, v1Marker, {
        timeout: "30 seconds",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

// ─────────────────────────────────────────────────────────────────────
// Path-relocation / cross-machine state behavior
//
// `StaticSite` builds via `Build.Command` and hands its `outdir` +
// content hash to `Worker` as `AssetsWithHash`. The hash is the only
// thing the diff/keepAssets logic should care about — the recorded
// `path` is *not* an input. These tests pin that down so that:
//
//   1. State produced on machine A (e.g. a CI runner) can be
//      re-applied on machine B without `NotFound` failures from a
//      stale `path` lurking in state.
//   2. A worker-only edit, with `src/` byte-identical, keeps the
//      asset manifest in place instead of re-uploading.
//   3. A genuine source edit (already covered above) bumps the
//      hash and ships new bytes — repeated here for symmetry.
// ─────────────────────────────────────────────────────────────────────

test.provider(
  "StaticSite: relocating the project (and deleting the old one) preserves hash.assets",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      // Include `.gitignore` so `Build.Command`'s default memo skips
      // `dist/` between deploys; without it, the build output from
      // deploy 1 would shift the input hash on deploy 2 and force an
      // unnecessary rebuild that defeats the test.
      const cwdA = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-staticsite-relocate-a-",
        entries: ["src", "build.sh", ".gitignore"],
      });

      // Pin a deterministic marker so both deploys hash to the same
      // bytes regardless of timestamps.
      const marker = `staticsite-relocate-${Date.now()}`;
      yield* fs.writeFileString(
        path.join(cwdA, "src", "index.html"),
        htmlPage(marker),
      );

      const site1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.StaticSite(
            "RelocSite",
            staticSiteProps(cwdA),
          );
        }),
      );
      expect(site1.hash?.assets).toBeDefined();
      yield* expectUrlContains(`${site1.url!}/index.html`, marker, {
        timeout: "120 seconds",
        label: "deploy1 marker",
      });

      // Simulate the CI→local handoff: throw away the directory the
      // first deploy ran in. Anything that still tries to readDir the
      // recorded `outdir` will blow up here — the keepAssets path
      // must not require it.
      yield* fs.remove(cwdA, { recursive: true });

      const cwdB = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-staticsite-relocate-b-",
        entries: ["src", "build.sh", ".gitignore"],
      });
      yield* fs.writeFileString(
        path.join(cwdB, "src", "index.html"),
        htmlPage(marker),
      );

      const site2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.StaticSite(
            "RelocSite",
            staticSiteProps(cwdB),
          );
        }),
      );

      // The build still runs (Build.Command always re-runs its
      // command), but the resulting content hash is identical, so
      // Worker takes the keepAssets path and the recorded
      // `hash.assets` is stable.
      expect(site2.hash?.assets).toEqual(site1.hash?.assets);
      // And the URL keeps serving — i.e. we didn't lose the asset
      // binding in the process.
      yield* expectUrlContains(`${site2.url!}/index.html`, marker, {
        timeout: "60 seconds",
        label: "deploy2 marker",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

test.provider(
  "StaticSite: a bundle-only change keeps the asset manifest (hash.assets stable)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      // Include `.gitignore` so the memo (which falls back to gitignore
      // when not explicitly configured) skips `dist/` between deploys —
      // otherwise the second `hashDirectory` would observe the build
      // output from deploy 1 and produce a different input hash.
      const cwd = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-staticsite-bundle-only-",
        entries: ["src", "build.sh", ".gitignore"],
      });
      const marker = `staticsite-bundle-only-${Date.now()}`;
      yield* fs.writeFileString(
        path.join(cwd, "src", "index.html"),
        htmlPage(marker),
      );
      // Use a temp worker entry so we can edit it between deploys to
      // shift `hash.bundle` without touching `src/`.
      const workerDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-staticsite-bundle-only-entry-",
      });
      const workerPath = path.join(workerDir, "worker.ts");
      const writeWorker = (variant: string) =>
        fs.writeFileString(
          workerPath,
          `export default {
  fetch: async () => new Response(${JSON.stringify(`bundle-only ${variant}`)}),
};
`,
        );

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.StaticSite("BundleOnlyStaticSite", {
              ...staticSiteProps(cwd),
              main: workerPath,
            });
          }),
        );

      yield* writeWorker("v1");
      const v1 = yield* deploy();
      expect(v1.hash?.assets).toBeDefined();
      expect(v1.hash?.bundle).toBeDefined();
      yield* expectUrlContains(`${v1.url!}/index.html`, marker, {
        timeout: "120 seconds",
        label: "v1 marker",
      });

      yield* writeWorker("v2");
      const v2 = yield* deploy();
      expect(v2.hash?.bundle).not.toEqual(v1.hash?.bundle);
      expect(v2.hash?.assets).toEqual(v1.hash?.assets);
      yield* expectUrlContains(`${v2.url!}/index.html`, marker, {
        timeout: "60 seconds",
        label: "v2 marker (assets unchanged)",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 360_000 },
);

const staticSiteProps = (cwd: string) => ({
  command: "bash build.sh",
  cwd,
  outdir: "dist",
  main: workerEntry,
  url: true as const,
  subdomain: { enabled: true, previewsEnabled: true },
  compatibility: { date: "2024-01-01" },
});

const htmlPage = (marker: string) => `<!doctype html>
<html>
  <head><title>${marker}</title></head>
  <body><h1>${marker}</h1></body>
</html>
`;

/**
 * Inverse of `expectUrlContains`: succeeds if the marker is *absent*
 * from the response within the timeout. We drive this off the same
 * primitive by inverting the check at the call site.
 */
const expectUrlAbsent = (
  url: string,
  marker: string,
  options: { timeout?: Duration.Input },
) =>
  Effect.gen(function* () {
    yield* expectUrlContains(url, "<", { ...options, label: "page exists" });
    const u = new URL(url);
    u.searchParams.set("__alchemy_cb", String(Date.now()));
    const body = yield* Effect.promise(() =>
      fetch(u, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
      }).then((r) => r.text()),
    );
    expect(
      body.includes(marker),
      `expected URL ${url} to NOT contain "${marker}", but it did`,
    ).toBe(false);
  });

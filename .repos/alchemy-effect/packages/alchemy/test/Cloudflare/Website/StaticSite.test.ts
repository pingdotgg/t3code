import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Command from "@/Command/index.ts";
import * as Output from "@/Output.ts";
import type * as Plan from "@/Plan.ts";
import { Stack } from "@/Stack";
import { encodeState, type ResourceState, reviveState, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains, expectUrlHeader } from "../Utils/Http.ts";
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

// Read back through `Config.string` by the #796 test below. Set at module
// load (collection time): `ConfigProvider.fromEnv` snapshots `process.env`
// when the test harness constructs the provider — BEFORE a test body runs —
// so setting this inside the test only ever satisfied the NEXT attempt
// (the failure was masked by the runner's default retry).
process.env.STATICSITE_ENV_TEST = "from-config";

describe.concurrent("StaticSite", () => {
  test.provider(
    "StaticSite: editing a source file republishes the assets in a single deploy",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
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
            return yield* Cloudflare.Website.StaticSite(
              "FixSite",
              staticSiteProps(cwd),
            );
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
            return yield* Cloudflare.Website.StaticSite(
              "FixSite",
              staticSiteProps(cwd),
            );
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

  test.provider(
    "StaticSite: class form deploys and serves the built assets",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-staticsite-class-",
          entries: ["src", "build.sh"],
        });
        const indexPath = path.join(cwd, "src", "index.html");

        const marker = `staticsite-class-${Date.now()}`;
        yield* fs.writeFileString(indexPath, htmlPage(marker));

        const site1 = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* class FixSite extends Cloudflare.Website.StaticSite<FixSite>()(
              "FixSite",
              staticSiteProps(cwd),
            ) {};
          }),
        );

        expect(site1.url).toBeDefined();
        expect(site1.hash?.assets).toBeDefined();
        yield* expectWorkerExists(site1.workerName, accountId);
        yield* expectUrlContains(`${site1.url!}/index.html`, marker, {
          timeout: "120 seconds",
          label: "class form marker",
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
        const { accountId } = yield* yield* CloudflareEnvironment;
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
            return yield* Cloudflare.Website.StaticSite(
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
            return yield* Cloudflare.Website.StaticSite(
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
        const { accountId } = yield* yield* CloudflareEnvironment;
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
              return yield* Cloudflare.Website.StaticSite(
                "BundleOnlyStaticSite",
                {
                  ...staticSiteProps(cwd),
                  main: workerPath,
                },
              );
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

  test.provider(
    "StaticSite: rebuilds when the build output is missing despite unchanged inputs",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-staticsite-missing-output-",
          entries: ["src", "build.sh", ".gitignore"],
        });
        const marker = `staticsite-missing-output-${Date.now()}`;
        yield* fs.writeFileString(
          path.join(cwd, "src", "index.html"),
          htmlPage(marker),
        );
        const outdir = path.join(cwd, "dist");

        const deploy = () =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Website.StaticSite(
                "MissingOutputStaticSite",
                staticSiteProps(cwd),
              );
            }),
          );

        const v1 = yield* deploy();
        expect(v1.hash?.assets).toBeDefined();
        expect(yield* fs.exists(outdir)).toBe(true);
        yield* expectUrlContains(`${v1.url!}/index.html`, marker, {
          timeout: "120 seconds",
          label: "v1 marker",
        });

        // Blow away the build output without touching any inputs. The input
        // hash is unchanged, so memoization alone would skip the rebuild — but
        // the Build provider also detects the missing output and forces an
        // update, otherwise the Worker would have no assets to publish.
        yield* fs.remove(outdir, { recursive: true });
        expect(yield* fs.exists(outdir)).toBe(false);

        const v2 = yield* deploy();
        // The build re-ran: the output directory is back and the asset hash is
        // identical (same source content reproduced the same manifest).
        expect(yield* fs.exists(outdir)).toBe(true);
        expect(v2.hash?.assets).toEqual(v1.hash?.assets);
        yield* expectUrlContains(`${v2.url!}/index.html`, marker, {
          timeout: "60 seconds",
          label: "v2 marker (output rebuilt)",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // #1056: the assets hash must be a string
  //
  // `Command.Build.hash` is a `{ input, output }` pair; `AssetsWithHash.hash`
  // is a single `string` that the Worker compares with `!==` against the value
  // it persisted. Handing the pair through made every redeploy dirty and
  // re-uploaded the whole asset directory, because state round-trips through
  // JSON and a freshly built object is never `===` its deserialized self.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Round-trip every state row through JSON, exactly like a real state store.
   *
   * `test.provider`'s scratch store keeps rows in memory *by reference*, so an
   * object-valued hash compares `===` against itself and this bug is invisible.
   * `localState` (and R2, and the HTTP store) serialize on write and revive on
   * read — that is what production plans diff against, so reproduce it here.
   */
  const roundTripState = Effect.gen(function* () {
    const state = yield* yield* State;
    const stk = yield* Stack;
    const fqns = yield* state.list({ stack: stk.name, stage: stk.stage });
    yield* Effect.forEach(fqns, (fqn) =>
      Effect.gen(function* () {
        const row = yield* state.get({
          stack: stk.name,
          stage: stk.stage,
          fqn,
        });
        if (row === undefined) return;
        yield* state.set({
          stack: stk.name,
          stage: stk.stage,
          fqn,
          value: JSON.parse(
            JSON.stringify(encodeState(row)),
            reviveState,
          ) as ResourceState,
        });
      }),
    );
  });

  const actionOf = (plan: Plan.Plan, fqn: string) =>
    plan.resources[fqn]?.action;

  test.provider(
    "StaticSite: redeploying an unchanged site is a noop (#1056)",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        // `.gitignore` keeps `dist/` out of the build's input hash, so the
        // second pass sees byte-identical inputs.
        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-staticsite-noop-",
          entries: ["src", "build.sh", ".gitignore"],
        });
        const marker = `staticsite-noop-${Date.now()}`;
        yield* fs.writeFileString(
          path.join(cwd, "src", "index.html"),
          htmlPage(marker),
        );

        const program = () =>
          Effect.gen(function* () {
            return yield* Cloudflare.Website.StaticSite(
              "NoopSite",
              staticSiteProps(cwd),
            );
          });

        const site = yield* stack.deploy(program());
        yield* expectWorkerExists(site.workerName, accountId);

        yield* roundTripState;

        // Zero source changes between the two passes, so nothing may plan as
        // changed. This is the user-visible defect: before the fix the Worker
        // planned `update` on every single deploy and re-uploaded the whole
        // asset directory, forever.
        const settled = yield* stack.plan(program());
        expect(actionOf(settled, "NoopSite/Build")).toBe("noop");
        // The Worker is declared at the site's own id (only Build/Dev are
        // namespaced under it), so its plan row is keyed `NoopSite`.
        expect(actionOf(settled, "NoopSite")).toBe("noop");

        // ...because the persisted hash is the build's `output` hash — the
        // content hash of the uploaded bytes — and not the `{ input, output }`
        // pair, which never compares equal to its own deserialized self.
        expect(typeof site.hash?.assets).toBe("string");

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  test.provider(
    "StaticSite: a memo:false build has no hash and still uploads the assets",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-staticsite-no-memo-",
          entries: ["src", "build.sh", ".gitignore"],
        });
        const marker = `staticsite-no-memo-${Date.now()}`;
        yield* fs.writeFileString(
          path.join(cwd, "src", "index.html"),
          htmlPage(marker),
        );

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.StaticSite("NoMemoSite", {
              ...staticSiteProps(cwd),
              memo: false,
            });
          }),
        );

        // `memo: false` computes no hashes, so the site hands the Worker
        // `hash: undefined` — the hash-*less* shape, which must make the
        // Worker hash `outdir` itself. Reading an explicit `undefined` as a
        // supplied hash instead makes a greenfield create compare `undefined
        // === undefined`, set `skip`, and publish a Worker with no assets.
        expect(site.hash?.assets).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);
        yield* expectUrlContains(`${site.url!}/index.html`, marker, {
          timeout: "120 seconds",
          label: "memo:false marker",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // Legacy state migration
  //
  // `StaticSite`'s build sub-resource was renamed `Build.Command` →
  // `Command.Build` and its `attr.hash` shape changed from a bare `string`
  // to `{ input, output }`. An existing deployment upgrading across the
  // rename has the old row on disk. Deploying the new `StaticSite` over it
  // must not error — it re-runs the build (the memoization shape changed)
  // and republishes the assets, migrating the row to the new type.
  // ─────────────────────────────────────────────────────────────────────
  test.provider(
    "StaticSite: deploys over legacy Build.Command state and republishes assets",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const state = yield* yield* State;
        const stk = yield* Stack;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-staticsite-migrate-",
          entries: ["src", "build.sh", ".gitignore"],
        });
        const marker = `staticsite-migrate-${Date.now()}`;
        yield* fs.writeFileString(
          path.join(cwd, "src", "index.html"),
          htmlPage(marker),
        );

        // Mirror `examples/.../Website__Build.json`: a pre-rename
        // `Build.Command` row at the build sub-resource's FQN, carrying the
        // legacy `attr.hash` string (pre-`{ input, output }`).
        yield* state.set({
          stack: stk.name,
          stage: stk.stage,
          fqn: "MigSite/Build",
          value: {
            status: "created",
            fqn: "MigSite/Build",
            logicalId: "Build",
            instanceId: "606bcaf4c0a931156f5a314ba7b57fc3",
            resourceType: "Build.Command",
            props: { command: "bash build.sh", outdir: "dist", env: {} },
            attr: {
              outdir: "dist",
              hash: "a41cbcecfdeb355f6f98130ca4ff8269d0ad5cc3a628f1918d956c71f859648c",
            },
            bindings: [],
            providerVersion: 0,
            downstream: ["MigSite/Worker"],
            removalPolicy: "destroy",
            namespace: { Id: "MigSite" },
          } satisfies ResourceState,
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.StaticSite(
              "MigSite",
              staticSiteProps(cwd),
            );
          }),
        );

        expect(site.url).toBeDefined();
        expect(site.hash?.assets).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);
        yield* expectUrlContains(`${site.url!}/index.html`, marker, {
          timeout: "120 seconds",
          label: "migrated site marker",
        });

        // The build sub-resource row migrated to the new resource type.
        const build = (yield* state.get({
          stack: stk.name,
          stage: stk.stage,
          fqn: "MigSite/Build",
        })) as ResourceState | undefined;
        expect(build?.resourceType).toBe("Command.Build");

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // Orphaned dev-server cleanup across the rename
  //
  // A prior `alchemy dev` run writes a `Build.DevServer` row at the
  // StaticSite's `Dev` sub-resource FQN. A subsequent normal `deploy` never
  // declares that dev resource, so the row is orphaned and must be torn
  // down. Before the `Renamed("Build.DevServer" → "Command.Dev")` shim
  // existed, that teardown failed: the engine couldn't resolve a provider
  // for the now-nonexistent `Build.DevServer` type and the deploy errored.
  // This guards that the deploy succeeds and the orphan is reaped.
  // ─────────────────────────────────────────────────────────────────────
  test.provider(
    "StaticSite: deploys cleanly when a legacy Build.DevServer row is orphaned",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const state = yield* yield* State;
        const stk = yield* Stack;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-staticsite-orphan-dev-",
          entries: ["src", "build.sh", ".gitignore"],
        });
        const marker = `staticsite-orphan-dev-${Date.now()}`;
        yield* fs.writeFileString(
          path.join(cwd, "src", "index.html"),
          htmlPage(marker),
        );

        // Mirror `examples/.../Website__Dev.json`: a pre-rename
        // `Build.DevServer` row left behind by an earlier `alchemy dev` run,
        // sitting at the `Dev` sub-resource FQN that a normal deploy never
        // declares.
        yield* state.set({
          stack: stk.name,
          stage: stk.stage,
          fqn: "MigSite/Dev",
          value: {
            status: "created",
            fqn: "MigSite/Dev",
            logicalId: "Dev",
            instanceId: "b4ca740550ef6e2e409481cedf9314c7",
            resourceType: "Build.DevServer",
            props: { command: "zola serve", env: {} },
            attr: { url: "http://127.0.0.1:1024" },
            bindings: [],
            providerVersion: 0,
            downstream: ["MigSite/Worker"],
            removalPolicy: "destroy",
            namespace: { Id: "MigSite" },
          } satisfies ResourceState,
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.StaticSite(
              "MigSite",
              staticSiteProps(cwd),
            );
          }),
        );

        expect(site.url).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);
        yield* expectUrlContains(`${site.url!}/index.html`, marker, {
          timeout: "120 seconds",
          label: "orphan-dev site marker",
        });

        // The orphaned dev-server row was reaped via the renamed provider.
        const orphan = yield* state.get({
          stack: stk.name,
          stage: stk.stage,
          fqn: "MigSite/Dev",
        });
        expect(orphan).toBeUndefined();

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  test.provider(
    "StaticSite: build env resolves Config, Output, and JSON values (#796)",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        // A build that snapshots the env vars it receives into its output.
        const cwd = yield* fs.makeTempDirectory({
          prefix: "alchemy-staticsite-env-",
        });
        yield* fs.writeFileString(
          path.join(cwd, "build.sh"),
          [
            "#!/bin/bash",
            "set -euo pipefail",
            "mkdir -p dist",
            "{",
            '  echo "FROM_STRING=${FROM_STRING:-missing}"',
            '  echo "FROM_CONFIG=${FROM_CONFIG:-missing}"',
            '  echo "FROM_OUTPUT=${FROM_OUTPUT:-missing}"',
            '  echo "FROM_OUTPUT_OBJECT=${FROM_OUTPUT_OBJECT:-missing}"',
            '  echo "FROM_NULL=${FROM_NULL:-missing}"',
            "} > dist/env.txt",
          ].join("\n"),
        );

        // A sibling resource whose attributes provide real `Output` values.
        const depCwd = yield* fs.makeTempDirectory({
          prefix: "alchemy-staticsite-env-dep-",
        });
        yield* fs.writeFileString(
          path.join(depCwd, "build.sh"),
          "#!/bin/bash\nmkdir -p dist\necho dep > dist/dep.txt\n",
        );

        // `STATICSITE_ENV_TEST` is set at module load (see top of file) —
        // the harness's ConfigProvider snapshots process.env before the
        // test body runs.
        yield* stack.deploy(
          Effect.gen(function* () {
            const dep = yield* Command.Build("EnvDep", {
              command: "bash build.sh",
              shell: true,
              cwd: depCwd,
              outdir: "dist",
            });
            return yield* Cloudflare.Website.StaticSite("EnvSite", {
              command: "bash build.sh",
              shell: true,
              cwd,
              outdir: "dist",
              workersDev: false,
              env: {
                FROM_STRING: "plain",
                FROM_CONFIG: Config.string("STATICSITE_ENV_TEST"),
                FROM_OUTPUT: dep.outdir,
                FROM_OUTPUT_OBJECT: Output.map(dep.outdir, (dir) => ({ dir })),
                // JS callers can pass `null`; it must serialize, not throw.
                FROM_NULL: null as unknown as string,
              },
            });
          }),
        );

        const envFile = yield* fs.readFileString(
          path.join(cwd, "dist", "env.txt"),
        );
        expect(envFile).toContain("FROM_STRING=plain");
        expect(envFile).toContain("FROM_CONFIG=from-config");
        // Resolved Output<string> — the dep's outdir path, not garbage.
        const fromOutput = envFile.match(/FROM_OUTPUT=(.*)/)?.[1];
        expect(fromOutput).toBeDefined();
        expect(fromOutput).not.toBe("missing");
        expect(fromOutput).toContain("dist");
        expect(fromOutput).not.toContain("[object");
        // Resolved Output<object> — serialized as JSON.
        const fromOutputObject = envFile.match(/FROM_OUTPUT_OBJECT=(.*)/)?.[1];
        expect(fromOutputObject).toContain('{"dir":');
        expect(envFile).toContain("FROM_NULL=null");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // SPA fallback: `assets.notFoundHandling: "single-page-application"`
  //
  // An assets-only deploy (no `main`) where Cloudflare's asset layer
  // answers every request itself: an unmatched deep link must fall back
  // to `index.html` with a 200 so a client router can boot, while real
  // assets keep serving their own bytes.
  // ─────────────────────────────────────────────────────────────────────

  test.provider(
    "StaticSite: SPA not-found handling serves index.html for deep links",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const cwd = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-staticsite-spa-",
          entries: ["src", "build.sh", ".gitignore"],
        });
        // Deterministic marker: the shell content is the assertion target
        // for both the direct fetch and the deep-link fallback.
        const marker = "staticsite-spa-shell";
        yield* fs.writeFileString(
          path.join(cwd, "src", "index.html"),
          htmlPage(marker),
        );
        // A sibling asset that must keep serving its own bytes, not the
        // shell, under SPA handling.
        yield* fs.writeFileString(
          path.join(cwd, "src", "data.txt"),
          "staticsite-spa-plain-asset",
        );
        // Binary assets whose uploads must carry real content types
        // (avif/jpeg/webp/woff2 previously fell back to
        // application/octet-stream).
        for (const name of [
          "sample.avif",
          "sample.jpg",
          "sample.webp",
          "sample.woff2",
        ]) {
          yield* fs.writeFile(
            path.join(cwd, "src", name),
            new Uint8Array([0x00, 0x01, 0x02, 0x03]),
          );
        }

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.StaticSite("SpaSite", {
              command: "bash build.sh",
              shell: true,
              cwd,
              outdir: "dist",
              workersDev: true,
              compatibility: { date: "2024-01-01" },
              // Assets-only (no `main`): with a Worker script in front,
              // unmatched requests would invoke the Worker instead of the
              // asset layer's not-found handling.
              assets: { notFoundHandling: "single-page-application" },
            });
          }),
        );

        expect(site.url).toBeDefined();
        expect(site.hash?.assets).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);

        // The shell serves at its real path.
        yield* expectUrlContains(`${site.url!}/index.html`, marker, {
          timeout: "120 seconds",
          label: "SPA shell at /index.html",
        });

        // A hard GET to a route that matches no asset falls back to the
        // shell with a 200 — `expectUrlContains` requires `res.ok`, so a
        // plain 404 can't satisfy this.
        yield* expectUrlContains(`${site.url!}/app/deep/route`, marker, {
          timeout: "60 seconds",
          label: "deep link falls back to index.html",
        });

        // A real asset still serves its own bytes, not the shell.
        const assetBody = yield* expectUrlContains(
          `${site.url!}/data.txt`,
          "staticsite-spa-plain-asset",
          {
            timeout: "60 seconds",
            label: "plain asset with SPA handling",
          },
        );
        expect(assetBody).not.toContain(marker);

        // Content types for common binary asset formats survive upload.
        for (const [name, contentType] of [
          ["sample.avif", "image/avif"],
          ["sample.jpg", "image/jpeg"],
          ["sample.webp", "image/webp"],
          ["sample.woff2", "font/woff2"],
        ] as const) {
          yield* expectUrlHeader(
            `${site.url!}/${name}`,
            "content-type",
            contentType,
          );
        }

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );
});

const staticSiteProps = (cwd: string): Cloudflare.Website.StaticSiteProps => ({
  command: "bash build.sh",
  shell: true,
  cwd,
  outdir: "dist",
  main: workerEntry,
  workersDev: true,
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

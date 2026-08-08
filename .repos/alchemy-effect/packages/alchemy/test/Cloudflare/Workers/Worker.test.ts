import { adopt } from "@/AdoptPolicy";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as R2 from "@/Cloudflare/R2";
import * as Provider from "@/Provider";
import * as Output from "@/Output";
import { Stack } from "@/Stack";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  expectWorkersDevPreviews,
  expectWorkersDevSubdomain,
  findWorker,
  getWorkerTags,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";
import type { Counter, Meter } from "./fixtures/do-counter-worker.ts";
import InternalWorker from "./fixtures/internal-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");
const doMain = pathe.resolve(
  import.meta.dirname,
  "fixtures/do-counter-worker.ts",
);

describe.concurrent("Cloudflare.Worker", () => {
  test.provider("create, update, delete worker", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const s = yield* Stack;

      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          yield* R2.Bucket("Bucket", {
            storageClass: "Standard",
          });

          const worker = yield* Cloudflare.Worker("TestWorker", {
            main,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: {
              date: "2024-01-01",
            },
          });

          return worker;
        }),
      );

      const actualWorker = yield* findWorker(worker.workerName, accountId);
      expect(actualWorker?.scriptName).toEqual(worker.workerName);
      expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
        `alchemy:stack:${s.name}`,
      );
      expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
        `alchemy:stage:${s.stage}`,
      );
      expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
        "alchemy:id:TestWorker",
      );

      // Verify the workers.dev subdomain is enabled on Cloudflare
      // (rather than just trusting the resource's output attributes).
      expect(worker.url).toBeDefined();
      const initialSubdomain = yield* workers.getScriptSubdomain({
        accountId,
        scriptName: worker.workerName,
      });
      expect(initialSubdomain).toEqual({
        enabled: true,
        previewsEnabled: true,
      });

      // Update the worker
      const updatedWorker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("TestWorker", {
            main,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: {
              date: "2024-01-01",
            },
          });
        }),
      );

      const actualUpdatedWorker = yield* findWorker(
        updatedWorker.workerName,
        accountId,
      );
      expect(actualUpdatedWorker?.scriptName).toEqual(updatedWorker.workerName);
      const actualUpdatedSubdomain = yield* workers.getScriptSubdomain({
        accountId,
        scriptName: updatedWorker.workerName,
      });
      expect(actualUpdatedSubdomain).toEqual({
        enabled: true,
        previewsEnabled: true,
      });

      yield* stack.destroy();

      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  );

  test.provider("create, update, delete worker with assets", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const s = yield* Stack;

      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("TestWorkerWithAssets", {
            main,
            assets: pathe.resolve(import.meta.dirname, "assets"),
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: {
              date: "2024-01-01",
            },
          });
        }),
      );

      const actualWorker = yield* findWorker(worker.workerName, accountId);
      expect(actualWorker?.scriptName).toEqual(worker.workerName);
      expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
        `alchemy:stack:${s.name}`,
      );
      expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
        `alchemy:stage:${s.stage}`,
      );
      expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
        "alchemy:id:TestWorkerWithAssets",
      );

      // Verify the worker has assets
      expect(worker.hash?.assets).toBeDefined();

      // Verify the workers.dev subdomain is enabled on Cloudflare
      // (rather than just trusting the resource's output attributes).
      expect(worker.url).toBeDefined();
      const assetsWorkerSubdomain = yield* workers.getScriptSubdomain({
        accountId,
        scriptName: worker.workerName,
      });
      expect(assetsWorkerSubdomain).toEqual({
        enabled: true,
        previewsEnabled: true,
      });

      // Update the worker
      const updatedWorker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("TestWorkerWithAssets", {
            main,
            assets: pathe.resolve(import.meta.dirname, "assets"),
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: {
              date: "2024-01-01",
            },
          });
        }),
      );

      const actualUpdatedWorker = yield* findWorker(
        updatedWorker.workerName,
        accountId,
      );
      expect(actualUpdatedWorker?.scriptName).toEqual(updatedWorker.workerName);
      expect(updatedWorker.hash?.assets).toBeDefined();

      // Final update
      const finalWorker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("TestWorkerWithAssets", {
            main,
            url: true,
            assets: pathe.resolve(import.meta.dirname, "assets"),
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: {
              date: "2024-01-01",
            },
          });
        }),
      );

      yield* stack.destroy();

      yield* waitForWorkerToBeDeleted(finalWorker.workerName, accountId);
    }).pipe(logLevel),
  );

  // ─────────────────────────────────────────────────────────────────────
  // Asset hashing & keepAssets behavior
  //
  // `hash.assets` is content-addressed: it must depend only on the bytes
  // in the directory, not on where the directory lives. The provider
  // uses that hash to decide whether to upload a fresh manifest or tell
  // Cloudflare to keep the existing one (`keepAssets: true`). These
  // tests pin down the user-visible contract:
  //
  //   1. Same bytes at a different path → same hash, no re-upload.
  //   2. Different bytes (any change) → new hash, re-upload.
  //   3. A worker-only change leaves the asset hash alone, so the
  //      script update goes out without re-walking the asset tree.
  //
  // The "moved path" cases also guard against the regression where state
  // written by one machine (e.g. a CI runner) recorded an absolute path
  // that the next machine couldn't open — the deploy used to crash with
  // `NotFound: FileSystem.readDirectory`.
  // ─────────────────────────────────────────────────────────────────────

  const assetsFixtureDir = pathe.resolve(import.meta.dirname, "assets");

  test.provider(
    "Worker assets: relocating to a fresh path with identical bytes preserves hash and keeps assets",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;

        yield* stack.destroy();

        const dirA = yield* cloneFixture(assetsFixtureDir, {
          prefix: "alchemy-worker-assets-a-",
        });
        const dirB = yield* cloneFixture(assetsFixtureDir, {
          prefix: "alchemy-worker-assets-b-",
        });

        const deploy = (assetsDir: string) =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("RelocatedAssets", {
                main,
                assets: assetsDir,
                url: true,
                subdomain: { enabled: true, previewsEnabled: true },
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

        const v1 = yield* deploy(dirA);
        expect(v1.hash?.assets).toBeDefined();
        yield* expectWorkerExists(v1.workerName, accountId);
        yield* expectUrlContains(`${v1.url!}/index.html`, "Hello from Worker", {
          timeout: "120 seconds",
          label: "v1 served",
        });

        // Wipe dirA before the second deploy. If anything in the apply
        // path still tries to read the previously-recorded directory,
        // this is where we'd fail with NotFound.
        yield* fs.remove(dirA, { recursive: true });

        const v2 = yield* deploy(dirB);

        // Identical bytes ⇒ identical asset hash ⇒ keepAssets path.
        expect(v2.hash?.assets).toEqual(v1.hash?.assets);
        // The script binding stayed live; the URL keeps serving.
        yield* expectUrlContains(`${v2.url!}/index.html`, "Hello from Worker", {
          timeout: "60 seconds",
          label: "v2 served",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  test.provider(
    "Worker assets: editing a file changes the hash and republishes the manifest",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const dir = yield* cloneFixture(assetsFixtureDir, {
          prefix: "alchemy-worker-assets-edit-",
        });
        const indexPath = path.join(dir, "index.html");

        const v1Marker = `worker-assets-v1-${Date.now()}`;
        yield* fs.writeFileString(
          indexPath,
          `<!doctype html><title>${v1Marker}</title><body>${v1Marker}</body>`,
        );

        const deploy = () =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("EditedAssets", {
                main,
                assets: dir,
                url: true,
                subdomain: { enabled: true, previewsEnabled: true },
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

        const v1 = yield* deploy();
        expect(v1.hash?.assets).toBeDefined();
        yield* expectUrlContains(`${v1.url!}/index.html`, v1Marker, {
          timeout: "120 seconds",
          label: "v1 marker",
        });

        const v2Marker = `worker-assets-v2-${Date.now()}`;
        yield* fs.writeFileString(
          indexPath,
          `<!doctype html><title>${v2Marker}</title><body>${v2Marker}</body>`,
        );

        const v2 = yield* deploy();
        expect(v2.hash?.assets).toBeDefined();
        expect(v2.hash?.assets).not.toEqual(v1.hash?.assets);
        yield* expectUrlContains(`${v2.url!}/index.html`, v2Marker, {
          timeout: "60 seconds",
          label: "v2 marker",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  test.provider(
    "Worker assets: a bundle-only change keeps the asset manifest (hash.assets stable)",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const dir = yield* cloneFixture(assetsFixtureDir, {
          prefix: "alchemy-worker-assets-bundle-only-",
        });
        // Write the worker entry into a fresh temp dir so we can edit
        // it between deploys to force a bundle hash change without
        // touching the assets directory.
        const workerDir = yield* fs.makeTempDirectory({
          prefix: "alchemy-worker-assets-bundle-only-entry-",
        });
        const workerPath = path.join(workerDir, "worker.ts");
        const writeWorker = (marker: string) =>
          fs.writeFileString(
            workerPath,
            `export default {
    fetch: async () => new Response(${JSON.stringify(`Hello from BundleOnly: ${marker}`)}),
  };
  `,
          );

        const deploy = () =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("BundleOnlyChange", {
                main: workerPath,
                assets: dir,
                url: true,
                subdomain: { enabled: true, previewsEnabled: true },
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

        yield* writeWorker("v1");
        const v1 = yield* deploy();
        expect(v1.hash?.assets).toBeDefined();
        expect(v1.hash?.bundle).toBeDefined();

        yield* writeWorker("v2");
        const v2 = yield* deploy();
        // Bundle changed (worker source edited) → hash.bundle moves.
        // Assets are byte-identical → hash.assets must not move, and
        // the keepAssets branch must keep the manifest live.
        expect(v2.hash?.bundle).not.toEqual(v1.hash?.bundle);
        expect(v2.hash?.assets).toEqual(v1.hash?.assets);
        yield* expectUrlContains(`${v2.url!}/index.html`, "Hello from Worker", {
          timeout: "60 seconds",
          label: "assets still served after bundle-only change",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  test.provider("create, update, delete internal worker", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const s = yield* Stack;

      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* InternalWorker;
        }),
      );

      const actualWorker = yield* findWorker(worker.workerName, accountId);
      expect(actualWorker?.scriptName).toEqual(worker.workerName);
      expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
        `alchemy:stack:${s.name}`,
      );
      expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
        `alchemy:stage:${s.stage}`,
      );
      expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
        "alchemy:id:InternalWorker",
      );

      const updatedWorker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* InternalWorker;
        }),
      );

      expect(updatedWorker.workerName).toEqual(worker.workerName);

      yield* stack.destroy();

      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  );

  // ── Engine-level adoption ─────────────────────────────────────────────────
  //
  // The engine always calls `provider.read` when there is no prior state, and
  // routes on the returned shape:
  //
  //   - undefined         → resource doesn't exist, drive a normal create
  //   - plain attrs       → resource exists and is owned by us (Worker
  //                         determines this from `alchemy:*` tags); silent
  //                         adoption regardless of `--adopt`
  //   - `Unowned(attrs)`  → resource exists but the tags don't identify us;
  //                         the engine fails with `OwnedBySomeoneElse` unless
  //                         the user opted in via `adopt(true)` / `--adopt`,
  //                         in which case it's a silent takeover.
  //
  // The tests below use `test.provider`'s scratch state so we can wipe state
  // mid-test while leaving the actual Cloudflare Worker in place — simulating
  // "the user created/deployed this worker before, but this state store has
  // never seen it" (e.g. CLI-driven first deploy on a fresh machine, or a
  // state-store reset).

  test.provider(
    "owned worker (matching alchemy tags) is silently adopted without --adopt",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        // Phase 1: deploy normally so a real Worker exists on Cloudflare,
        // tagged with this stack/stage/id. No explicit `name` — the engine
        // generates a random-suffixed physical name (collision-free across
        // concurrent runs, and alchemy-tagged so a crashed run's leftover is
        // sweepable). The deploy output hands back the real name, which
        // pins the worker's identity for the adoption phase below.
        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("AdoptableWorker", {
              main,
              subdomain: { enabled: true, previewsEnabled: true },
              compatibility: { date: "2024-01-01" },
            });
          }),
        );
        const physicalName = initial.workerName;
        expect(yield* findWorker(physicalName, accountId)).toBeDefined();

        // Phase 2: wipe local state for this resource — the worker stays on
        // Cloudflare. From the next deploy's perspective this looks like a
        // fresh state store that has never seen this resource.
        yield* Effect.gen(function* () {
          const state = yield* yield* State;
          yield* state.delete({
            stack: stack.name,
            stage: "test",
            fqn: "AdoptableWorker",
          });
        }).pipe(Effect.provide(stack.state));

        // Phase 3: redeploy *without* `adopt(true)`. The engine calls
        // `provider.read`, the Worker's read sees its own alchemy tags and
        // returns plain (owned) attrs, and the engine silently adopts.
        // No `--adopt` flag is required.
        const adopted = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("AdoptableWorker", {
              main,
              name: physicalName,
              subdomain: { enabled: true, previewsEnabled: true },
              compatibility: { date: "2024-01-01" },
            });
          }),
        );

        expect(adopted.workerName).toEqual(physicalName);

        const persisted = yield* Effect.gen(function* () {
          const state = yield* yield* State;
          return yield* state.get({
            stack: stack.name,
            stage: "test",
            fqn: "AdoptableWorker",
          });
        }).pipe(Effect.provide(stack.state));

        expect(persisted?.status).toBeDefined();
        expect((persisted as any)?.attr).toMatchObject({
          workerName: physicalName,
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(physicalName, accountId);
      }).pipe(logLevel),
  );

  test.provider("adopt(true) takes over a foreign-tagged worker", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Phase 1: deploy under logical id "Original". The Cloudflare Worker
      // is now tagged `alchemy:id:Original` — i.e. owned by *that* logical
      // resource. No explicit `name` — the engine generates a random-suffixed
      // physical name (collision-free across runs); the deploy output hands
      // back the real name, which phase 2 reuses to target the same worker.
      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("Original", {
            main,
            subdomain: { enabled: true, previewsEnabled: true },
            compatibility: { date: "2024-01-01" },
          });
        }),
      );
      const physicalName = original.workerName;
      expect(yield* findWorker(original.workerName, accountId)).toBeDefined();
      expect(yield* getWorkerTags(physicalName, accountId)).toContain(
        "alchemy:id:Original",
      );

      // Wipe state for the "Original" entry; the worker stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "Original",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 2: redeploy under a *different* logical id with the same
      // physical name and `adopt(true)`. `Worker.read` returns
      // `Unowned(attrs)` because the existing tags identify a different
      // logical id; with adopt enabled the engine takes over and the
      // follow-up create/update rewrites the tags. (The rejection path
      // — same scenario without `adopt(true)` — is covered by the unit
      // tests in `plan.test.ts`.)
      const takenOver = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("Different", {
              main,
              name: physicalName,
              subdomain: { enabled: true, previewsEnabled: true },
              compatibility: { date: "2024-01-01" },
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.workerName).toEqual(physicalName);

      const newTags = yield* getWorkerTags(physicalName, accountId);
      expect(newTags).toContain("alchemy:id:Different");
      expect(newTags).not.toContain("alchemy:id:Original");

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(physicalName, accountId);
    }).pipe(logLevel),
  );

  // First-deploy behaviour: the default (omitting `url`) must enable
  // the workers.dev subdomain, and `url: false` must disable it. Both
  // are asserted against live Cloudflare state via `getScriptSubdomain`,
  // not just the resource's output attributes.
  test.provider(
    "url defaults to enabling the workers.dev subdomain on first deploy",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("SubdomainDefaultWorker", {
              main,
              compatibility: { date: "2024-01-01" },
            });
          }),
        );

        expect(worker.url).toBeDefined();
        yield* expectWorkersDevSubdomain(worker.workerName, accountId, true);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }).pipe(logLevel),
  );

  test.provider(
    "url: false disables the workers.dev subdomain on first deploy",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("SubdomainDisabledWorker", {
              main,
              url: false,
              compatibility: { date: "2024-01-01" },
            });
          }),
        );

        expect(worker.url).toBeUndefined();
        yield* expectWorkersDevSubdomain(worker.workerName, accountId, false);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }).pipe(logLevel),
  );

  // Update regression: toggling `url` between deploys must propagate
  // to the live Cloudflare subdomain state. Before this regression
  // was fixed, the reconciler diffed `news.url !== olds.url` and
  // drove the API call symmetrically — but the new observed-vs-
  // desired check inside reconcile must still flip the toggle when
  // props really do change.
  test.provider(
    "toggling url between deploys flips the workers.dev subdomain",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const deploy = (url: boolean) =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("SubdomainToggleWorker", {
                main,
                url,
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

        const v1 = yield* deploy(true);
        expect(v1.url).toBeDefined();
        yield* expectWorkersDevSubdomain(v1.workerName, accountId, true);

        const v2 = yield* deploy(false);
        expect(v2.workerName).toEqual(v1.workerName);
        expect(v2.url).toBeUndefined();
        yield* expectWorkersDevSubdomain(v2.workerName, accountId, false);

        const v3 = yield* deploy(true);
        expect(v3.workerName).toEqual(v1.workerName);
        expect(v3.url).toBeDefined();
        yield* expectWorkersDevSubdomain(v3.workerName, accountId, true);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
      }).pipe(logLevel),
  );

  // Drift regression: if something external (a previous failed deploy,
  // a Cloudflare dashboard toggle, the bootstrap path in `loginWithCloudflare`)
  // leaves the workers.dev subdomain in `enabled: true, previewsEnabled: false`,
  // a redeploy must observe `previewsEnabled` and flip it back on. The
  // pre-fix reconciler diffed only `enabled` against desired, so it
  // skipped the API call and let the drift persist.
  test.provider(
    "redeploy re-enables previewsEnabled when externally disabled",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        // Deploy with different compatibility dates to force the update.
        const deploy = (date: string) =>
          stack.deploy(
            Cloudflare.Worker("SubdomainPreviewsDriftWorker", {
              main,
              compatibility: { date },
            }),
          );

        const v1 = yield* deploy("2026-01-01");
        yield* expectWorkersDevPreviews(v1.workerName, accountId, {
          enabled: true,
          previewsEnabled: true,
        });

        // Simulate external drift: leave `enabled: true` but turn
        // `previewsEnabled` off out-of-band.
        yield* workers.createScriptSubdomain({
          accountId,
          scriptName: v1.workerName,
          enabled: true,
          previewsEnabled: false,
        });
        const drifted = yield* workers.getScriptSubdomain({
          accountId,
          scriptName: v1.workerName,
        });
        expect(drifted).toEqual({ enabled: true, previewsEnabled: false });

        const v2 = yield* deploy("2026-01-02");
        expect(v2.workerName).toEqual(v1.workerName);
        yield* expectWorkersDevPreviews(v2.workerName, accountId, {
          enabled: true,
          previewsEnabled: true,
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
      }).pipe(logLevel),
  );

  // #745 regression: metadata-only edits (compatibility flags, observability,
  // placement, limits, logpush, env literals, ...) never touch the
  // bundle/vite/asset-content hashes, so the update decision used to plan
  // them as a noop and silently skip the deploy. `hash.metadata` makes them
  // visible to the diff. Deploy a worker, re-deploy with a
  // compatibility-flag-only and then an observability-only change, and
  // assert each change actually lands in the live script settings. Identical
  // props must keep planning as a noop — that guards the hash's stability
  // across runs (Redacted env values hash by value, not by reference, so the
  // freshly-constructed secret in each plan must not force a phantom update).
  test.provider(
    "metadata-only changes (compatibility flags, observability) deploy",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const program = (opts: { flags: string[]; observability: boolean }) =>
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("MetadataOnlyWorker", {
              main,
              compatibility: { date: "2024-01-01", flags: opts.flags },
              observability: { enabled: opts.observability },
              env: { WORKER_SECRET: Redacted.make("metadata-hash-stability") },
            });
          });

        const actionOf = (plan: any, logicalId: string) =>
          (Object.values(plan.resources) as any[]).find(
            (node: any) => node.resource.LogicalId === logicalId,
          )?.action;

        const v1 = yield* stack.deploy(
          program({ flags: [], observability: false }),
        );

        // Identical props → noop.
        const stablePlan = yield* stack.plan(
          program({ flags: [], observability: false }),
        );
        expect(actionOf(stablePlan, "MetadataOnlyWorker")).toBe("noop");

        // A compatibility-flag-only change must plan as an update ...
        const flagPlan = yield* stack.plan(
          program({ flags: ["nodejs_als"], observability: false }),
        );
        expect(actionOf(flagPlan, "MetadataOnlyWorker")).toBe("update");

        // ... and the deploy must apply it to the live script settings.
        const v2 = yield* stack.deploy(
          program({ flags: ["nodejs_als"], observability: false }),
        );
        expect(v2.workerName).toEqual(v1.workerName);
        const flagSettings = yield* workers.getScriptScriptAndVersionSetting({
          accountId,
          scriptName: v2.workerName,
        });
        expect(flagSettings.compatibilityFlags).toContain("nodejs_als");

        // Same for an observability-only change. The bundle hash must not
        // move — proof the update decision came from the metadata hash alone,
        // not from an incidental rebuild.
        const v3 = yield* stack.deploy(
          program({ flags: ["nodejs_als"], observability: true }),
        );
        expect(v3.hash?.bundle).toEqual(v2.hash?.bundle);
        const observabilitySettings =
          yield* workers.getScriptScriptAndVersionSetting({
            accountId,
            scriptName: v3.workerName,
          });
        expect(observabilitySettings.observability?.enabled).toBe(true);

        // The applied props are now the stored state → back to noop.
        const settledPlan = yield* stack.plan(
          program({ flags: ["nodejs_als"], observability: true }),
        );
        expect(actionOf(settledPlan, "MetadataOnlyWorker")).toBe("noop");

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // #874 regression: binding a tagged Worker identity (an Effect class) in
  // another Worker's `env` — the circular-bindings pattern — must converge.
  // The tag stays in the desired props (`news.env.TARGET` is an Effect) while
  // `stripUnresolved` removes it from the stored props at commit, so a diff
  // that compares the two raw shapes plans an update on every deploy, forever.
  // After a successful deploy, an identical program must plan as a noop —
  // and a code-only change must STILL plan as an update (the tag must not
  // knock the diff off its bundle-hash path onto the raw-props fallback,
  // which can't see file contents).
  test.provider(
    "Effect-valued worker tag in env converges to a noop plan",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        class EnvTagTarget extends Cloudflare.Worker<EnvTagTarget, {}>()(
          "EnvTagTargetWorker",
        ) {}
        class EnvTagCaller extends Cloudflare.Worker<EnvTagCaller, {}>()(
          "EnvTagCallerWorker",
        ) {}

        // The caller's entry lives in a temp dir so the test can edit its
        // contents mid-flight without touching the shared checked-in fixture.
        const callerScript = (marker: string) =>
          `export default { fetch: async () => new Response(${JSON.stringify(marker)}) };\n`;
        const tempDir = yield* fs.makeTempDirectory({
          prefix: "alchemy-env-tag-worker",
        });
        const callerMain = path.join(tempDir, "worker.ts");
        yield* fs.writeFileString(callerMain, callerScript("v1"));

        const layers = Layer.mergeAll(
          EnvTagTarget.make({ main, isExternal: true }, Effect.succeed({})),
          EnvTagCaller.make(
            {
              main: callerMain,
              isExternal: true,
              env: { TARGET: EnvTagTarget },
            },
            Effect.succeed({}),
          ),
        );

        const program = () =>
          Effect.gen(function* () {
            const target = yield* EnvTagTarget;
            const caller = yield* EnvTagCaller;
            return { target, caller };
          }).pipe(Effect.provide(layers));

        const actionOf = (plan: any, logicalId: string) =>
          (Object.values(plan.resources) as any[]).find(
            (node: any) => node.resource.LogicalId === logicalId,
          )?.action;

        const deployed = yield* stack.deploy(program());

        // The env tag must have landed as a live service binding.
        const settings = yield* workers.getScriptScriptAndVersionSetting({
          accountId,
          scriptName: deployed.caller.workerName,
        });
        expect(settings.bindings).toContainEqual(
          expect.objectContaining({
            type: "service",
            name: "TARGET",
            service: deployed.target.workerName,
          }),
        );

        // Identical program → both workers plan as noop.
        const settledPlan = yield* stack.plan(program());
        expect(actionOf(settledPlan, "EnvTagTargetWorker")).toBe("noop");
        expect(actionOf(settledPlan, "EnvTagCallerWorker")).toBe("noop");

        // A code-only change to the caller's entry (identical props — the
        // bundle hash is the only difference) must still plan as an update.
        yield* fs.writeFileString(callerMain, callerScript("v2"));
        const codeChangePlan = yield* stack.plan(program());
        expect(actionOf(codeChangePlan, "EnvTagTargetWorker")).toBe("noop");
        expect(actionOf(codeChangePlan, "EnvTagCallerWorker")).toBe("update");

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(deployed.caller.workerName, accountId);
        yield* waitForWorkerToBeDeleted(deployed.target.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // The full circular case from the #874 report: A and B each bind the
  // OTHER's tag in env. The tags keep the dependency on the binding channel
  // (precreate stubs + converge pass) — a cycle the props channel cannot
  // express — and both workers must still converge to noop plans.
  test.provider(
    "circular worker tags in env converge to noop plans",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        class CircTagA extends Cloudflare.Worker<CircTagA, {}>()(
          "CircTagAWorker",
        ) {}
        class CircTagB extends Cloudflare.Worker<CircTagB, {}>()(
          "CircTagBWorker",
        ) {}

        const layers = Layer.mergeAll(
          CircTagA.make(
            { main, isExternal: true, env: { PEER: CircTagB } },
            Effect.succeed({}),
          ),
          CircTagB.make(
            { main, isExternal: true, env: { PEER: CircTagA } },
            Effect.succeed({}),
          ),
        );

        const program = () =>
          Effect.gen(function* () {
            const a = yield* CircTagA;
            const b = yield* CircTagB;
            return { a, b };
          }).pipe(Effect.provide(layers));

        const actionOf = (plan: any, logicalId: string) =>
          (Object.values(plan.resources) as any[]).find(
            (node: any) => node.resource.LogicalId === logicalId,
          )?.action;

        const deployed = yield* stack.deploy(program());

        // Each side must carry a live service binding to the other.
        for (const [self, peer] of [
          [deployed.a, deployed.b],
          [deployed.b, deployed.a],
        ] as const) {
          const settings = yield* workers.getScriptScriptAndVersionSetting({
            accountId,
            scriptName: self.workerName,
          });
          expect(settings.bindings).toContainEqual(
            expect.objectContaining({
              type: "service",
              name: "PEER",
              service: peer.workerName,
            }),
          );
        }

        const settled = yield* stack.plan(program());
        expect(actionOf(settled, "CircTagAWorker")).toBe("noop");
        expect(actionOf(settled, "CircTagBWorker")).toBe("noop");

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(deployed.a.workerName, accountId);
        yield* waitForWorkerToBeDeleted(deployed.b.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // #874 (comments): an Output-valued `worker.bind` binding must also
  // converge. Terminal apply commits must persist the RESOLVED binding
  // payload — raw `node.bindings` hold the Output expression, which JSON
  // state stores silently drop, so every later plan's `diffBindings` would
  // compare a lossy stored shape against resolved data and re-update
  // forever (the PR #266 path).
  test.provider(
    "Output-valued worker.bind binding converges to a noop plan",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const program = () =>
          Effect.gen(function* () {
            const source = yield* Cloudflare.Worker("BindTextSource", {
              main,
            });
            const host = yield* Cloudflare.Worker("BindTextHost", {
              main,
            });
            // `source.workerName` is an Output<string> at plan time — the
            // same shape as an Action-produced value bound as plain_text.
            yield* host.bind`REV`({
              bindings: [
                { type: "plain_text", name: "REV", text: source.workerName },
              ],
            });
            return { source, host };
          });

        const actionOf = (plan: any, logicalId: string) =>
          (Object.values(plan.resources) as any[]).find(
            (node: any) => node.resource.LogicalId === logicalId,
          )?.action;

        const deployed = yield* stack.deploy(program());

        // The resolved text must have landed in the live binding.
        const settings = yield* workers.getScriptScriptAndVersionSetting({
          accountId,
          scriptName: deployed.host.workerName,
        });
        expect(settings.bindings).toContainEqual(
          expect.objectContaining({
            type: "plain_text",
            name: "REV",
            text: deployed.source.workerName,
          }),
        );

        const settled = yield* stack.plan(program());
        expect(actionOf(settled, "BindTextSource")).toBe("noop");
        expect(actionOf(settled, "BindTextHost")).toBe("noop");

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(deployed.host.workerName, accountId);
        yield* waitForWorkerToBeDeleted(deployed.source.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // Effect-valued env entries are stripped from the props comparison (#874),
  // so change detection for them rides entirely on the evaluated binding
  // data. This test guards that channel: when only the VALUE an env Effect
  // resolves to changes (a `gen` Effect — serializes value-blind, so the
  // props comparison could never see it), the plan must still flip from
  // noop to update.
  test.provider(
    "changing the value of an Effect-valued env entry plans an update",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const program = (value: string) =>
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("EffectEnvValueWorker", {
              main,
              env: {
                VALUE: Effect.gen(function* () {
                  return value;
                }),
              },
            });
          });

        const actionOf = (plan: any, logicalId: string) =>
          (Object.values(plan.resources) as any[]).find(
            (node: any) => node.resource.LogicalId === logicalId,
          )?.action;

        const deployed = yield* stack.deploy(program("v1"));

        // The evaluated value lands as a plain_text binding.
        const settings = yield* workers.getScriptScriptAndVersionSetting({
          accountId,
          scriptName: deployed.workerName,
        });
        expect(settings.bindings).toContainEqual(
          expect.objectContaining({
            type: "plain_text",
            name: "VALUE",
            text: "v1",
          }),
        );

        // Same value → noop; changed value → update.
        const samePlan = yield* stack.plan(program("v1"));
        expect(actionOf(samePlan, "EffectEnvValueWorker")).toBe("noop");
        const changedPlan = yield* stack.plan(program("v2"));
        expect(actionOf(changedPlan, "EffectEnvValueWorker")).toBe("update");

        // The changed value must actually deploy — and then converge.
        const redeployed = yield* stack.deploy(program("v2"));
        const updatedSettings = yield* workers.getScriptScriptAndVersionSetting(
          {
            accountId,
            scriptName: redeployed.workerName,
          },
        );
        expect(updatedSettings.bindings).toContainEqual(
          expect.objectContaining({
            type: "plain_text",
            name: "VALUE",
            text: "v2",
          }),
        );
        const resettled = yield* stack.plan(program("v2"));
        expect(actionOf(resettled, "EffectEnvValueWorker")).toBe("noop");

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(deployed.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // `domains` should reflect the workers.dev URL when the subdomain is
  // enabled and be empty when it isn't. `worker.url` is just `domains[0]`,
  // so the two must stay in lockstep across deploys.
  test.provider(
    "domains reflects the workers.dev subdomain and tracks url",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const deploy = (url: boolean) =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("DomainsWorker", {
                main,
                url,
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

        const enabled = yield* deploy(true);
        expect(enabled.domains).toHaveLength(1);
        expect(enabled.domains[0]).toMatch(/\.workers\.dev$/);
        expect(enabled.url).toEqual(enabled.domains[0]);

        const disabled = yield* deploy(false);
        expect(disabled.domains).toEqual([]);
        expect(disabled.url).toBeUndefined();

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(enabled.workerName, accountId);
      }).pipe(logLevel),
  );

  // When custom domains are attached, they come first in `domains` (in
  // the order the user provided them), followed by the workers.dev URL
  // when the subdomain is enabled. `worker.url` is `domains[0]`, so the
  // custom domain wins.
  const customDomainZone = process.env.CLOUDFLARE_TEST_WORKER_DOMAIN_ZONE_NAME;
  test.provider.skipIf(!customDomainZone)(
    "domains puts custom domains before workers.dev and url is the first",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const suffix = process.env.PULL_REQUEST ?? process.env.USER ?? "local";
        const domainA = `alchemy-worker-a-${suffix}.${customDomainZone}`;
        const domainB = `alchemy-worker-b-${suffix}.${customDomainZone}`;

        yield* stack.destroy();

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("CustomDomainWorker", {
              main,
              domain: [domainA, domainB],
              compatibility: { date: "2024-01-01" },
            });
          }),
        );

        expect(worker.domains.slice(0, 2)).toEqual([
          `https://${domainA}`,
          `https://${domainB}`,
        ]);
        expect(worker.domains[2]).toMatch(/\.workers\.dev$/);
        expect(worker.url).toEqual(`https://${domainA}`);

        // Reorder — `domains[0]` should follow.
        const swapped = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("CustomDomainWorker", {
              main,
              domain: [domainB, domainA],
              compatibility: { date: "2024-01-01" },
            });
          }),
        );
        expect(swapped.domains.slice(0, 2)).toEqual([
          `https://${domainB}`,
          `https://${domainA}`,
        ]);
        expect(swapped.url).toEqual(`https://${domainB}`);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }).pipe(logLevel),
  );

  // Canonical `list()` test (account collection): deploy a real Worker and
  // assert it shows up in the exhaustively-paginated account-wide listing.
  test.provider("list enumerates the deployed worker", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("ListWorker", {
            main,
            compatibility: { date: "2024-01-01" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Worker);
      const all = yield* provider.list();

      expect(all.some((w) => w.workerName === worker.workerName)).toBe(true);
      const found = all.find((w) => w.workerName === worker.workerName);
      expect(found?.workerId).toEqual(worker.workerId);
      expect(found?.accountId).toEqual(accountId);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  );

  test.provider(
    "downstream referencing worker.url is not re-updated when the worker changes",
    (stack) =>
      // Regression: a downstream resource that references `worker.url` as a
      // plain prop (e.g. a GitHub Webhook delivery URL built via
      // `Output.interpolate`) must not spuriously re-update every time the
      // upstream worker changes. The worker's url is stable across a
      // code/config change, so the planner must resolve `worker.url` to a
      // concrete value (rather than an unresolved Output, which would make
      // `havePropsChanged` short-circuit on `Output.hasOutputs` and force a
      // phantom update) and plan the downstream as a no-op.
      Effect.gen(function* () {
        yield* stack.destroy();

        // A worker plus a notification webhook whose `url` prop points at the
        // worker (a plain prop dependency, exactly like a GitHub webhook's
        // delivery URL). `crons` is the only thing that varies between the
        // deploy and the re-plan — it forces the worker to plan as an
        // `update` while leaving its url untouched.
        const program = (crons: string[]) =>
          Effect.gen(function* () {
            const worker = yield* Cloudflare.Worker("Upstream", {
              main,
              crons,
              compatibility: { date: "2024-01-01" },
            });
            yield* Cloudflare.Alerting.NotificationWebhook("Hook", {
              url: Output.interpolate`${worker.url}`,
            });
          });

        yield* stack.deploy(program([]));

        // Re-plan with the worker changed (a new cron forces an update) but
        // the webhook identical. The plan is never applied, so the cron is
        // never actually deployed.
        const plan = yield* stack.plan(program(["*/10 * * * *"]));

        const actionOf = (logicalId: string) =>
          Object.values(plan.resources).find(
            (node) => node.resource.LogicalId === logicalId,
          )?.action;

        expect(actionOf("Upstream")).toBe("update");
        expect(actionOf("Hook")).toBe("noop");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 180_000 },
  );

  test.provider(
    "worker.durableObjectNamespaces stability across DO and worker changes",
    (stack) =>
      // Exercises plan actions for a downstream resource whose props reference
      // `worker.durableObjectNamespaces.<ClassName>`. Scenarios:
      //
      // | Step                         | Worker     | Hook       |
      // |------------------------------|------------|------------|
      // | First deploy (no DO)         | create     | —          |
      // | Add first DO + hook          | update     | create     |
      // | Worker-only change           | update     | noop       |
      // | Add another DO class         | update     | noop       |
      // | Remove a DO class            | update     | update     |
      // | Worker-only change (restored)| update     | noop       |
      // | Swap DO class (add+remove)   | update     | noop       |
      // | Deploy swap + hook follows   | (apply)    | (apply)    |
      // | No further changes           | noop       | noop       |
      // | Remove last DO class         | update     | update     |
      Effect.gen(function* () {
        yield* stack.destroy();

        type DoClass = "Counter" | "Meter";

        const program = (opts: {
          crons: string[];
          dos: ReadonlyArray<DoClass>;
          hookRef: DoClass | null;
        }) =>
          Effect.gen(function* () {
            const bindings: any = {};
            if (opts.dos.includes("Counter")) {
              bindings.Counter = Cloudflare.DurableObject<Counter>("Counter");
            }
            if (opts.dos.includes("Meter")) {
              bindings.Meter = Cloudflare.DurableObject<Meter>("Meter");
            }

            const worker = yield* Cloudflare.Worker("Upstream", {
              main: doMain,
              crons: opts.crons,
              compatibility: { date: "2024-09-23" },
              bindings,
            } as any);

            if (opts.hookRef !== null) {
              // Embed the DO namespace id in the (real, reachable) worker URL so
              // the webhook's live URL validation passes while still depending on
              // `durableObjectNamespaces`. The worker responds 200 to any path.
              yield* Cloudflare.Alerting.NotificationWebhook("Hook", {
                url: Output.interpolate`${worker.url}/${worker.durableObjectNamespaces.pipe(
                  Output.map((namespaces) => namespaces[opts.hookRef!]),
                )}`,
              });
            }
          });

        const actionOf = (plan: any, logicalId: string) =>
          (Object.values(plan.resources) as any[]).find(
            (node: any) => node.resource.LogicalId === logicalId,
          )?.action;

        // ── First deploy: worker with no DO classes yet ──
        const workerOnlyFirstPlan = yield* stack.plan(
          program({ crons: [], dos: [], hookRef: null }),
        );
        expect(actionOf(workerOnlyFirstPlan, "Upstream")).toBe("create");
        expect(actionOf(workerOnlyFirstPlan, "Hook")).toBeUndefined();

        yield* stack.deploy(program({ crons: [], dos: [], hookRef: null }));

        // ── Add the first DO class + hook referencing it ──
        const addFirstDoPlan = yield* stack.plan(
          program({ crons: [], dos: ["Counter"], hookRef: "Counter" }),
        );
        expect(actionOf(addFirstDoPlan, "Upstream")).toBe("update");
        expect(actionOf(addFirstDoPlan, "Hook")).toBe("create");

        yield* stack.deploy(
          program({ crons: [], dos: ["Counter"], hookRef: "Counter" }),
        );

        // ── Worker-only change, same DO set → hook noop ──
        const workerOnlyPlan = yield* stack.plan(
          program({
            crons: ["*/10 * * * *"],
            dos: ["Counter"],
            hookRef: "Counter",
          }),
        );
        expect(actionOf(workerOnlyPlan, "Upstream")).toBe("update");
        expect(actionOf(workerOnlyPlan, "Hook")).toBe("noop");

        // ── Add a DO class (Meter) while hook still refs Counter → Counter's
        // namespace id is unchanged, so the hook is a noop even though the
        // worker must update to register the new class ──
        const addDoPlan = yield* stack.plan(
          program({
            crons: ["*/10 * * * *"],
            dos: ["Counter", "Meter"],
            hookRef: "Counter",
          }),
        );
        expect(actionOf(addDoPlan, "Upstream")).toBe("update");
        expect(actionOf(addDoPlan, "Hook")).toBe("noop");

        yield* stack.deploy(
          program({
            crons: ["*/10 * * * *"],
            dos: ["Counter", "Meter"],
            hookRef: "Counter",
          }),
        );

        // ── Remove a DO class (Meter) while hook still refs Counter → DO set
        // changed, so the hook must re-plan even though Counter's id is
        // unchanged in the cloud ──
        const removeDoPlan = yield* stack.plan(
          program({
            crons: ["*/10 * * * *"],
            dos: ["Counter"],
            hookRef: "Counter",
          }),
        );
        expect(actionOf(removeDoPlan, "Upstream")).toBe("update");
        expect(actionOf(removeDoPlan, "Hook")).toBe("update");

        yield* stack.deploy(
          program({
            crons: ["*/10 * * * *"],
            dos: ["Counter"],
            hookRef: "Counter",
          }),
        );

        // ── Same DO set restored → hook noop on another worker-only change ──
        const stableAgainPlan = yield* stack.plan(
          program({ crons: [], dos: ["Counter"], hookRef: "Counter" }),
        );
        expect(actionOf(stableAgainPlan, "Upstream")).toBe("update");
        expect(actionOf(stableAgainPlan, "Hook")).toBe("noop");

        // ── Swap Counter → Meter (add & remove in one step), hook still refs
        // Counter. The worker must update; the hook plans as noop because the
        // persisted Counter namespace id is still carried in state until apply ──
        const swapDoPlan = yield* stack.plan(
          program({
            crons: [],
            dos: ["Meter"],
            hookRef: "Counter",
          }),
        );
        expect(actionOf(swapDoPlan, "Upstream")).toBe("update");
        expect(actionOf(swapDoPlan, "Hook")).toBe("noop");

        yield* stack.deploy(
          program({
            crons: [],
            dos: ["Meter"],
            hookRef: "Meter",
          }),
        );

        // ── No further changes → noop ──
        const hookFollowsDoPlan = yield* stack.plan(
          program({ crons: [], dos: ["Meter"], hookRef: "Meter" }),
        );
        expect(actionOf(hookFollowsDoPlan, "Upstream")).toBe("noop");
        expect(actionOf(hookFollowsDoPlan, "Hook")).toBe("noop");

        // ── Remove the last DO class entirely while hook still refs Meter →
        // hook must update (plan-only; URL would be invalid to deploy) ──
        const removeLastDoPlan = yield* stack.plan(
          program({ crons: [], dos: [], hookRef: "Meter" }),
        );
        expect(actionOf(removeLastDoPlan, "Upstream")).toBe("update");
        expect(actionOf(removeLastDoPlan, "Hook")).toBe("update");

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 360_000 },
  );
});

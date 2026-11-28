import { pathToFileURL } from "node:url";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import * as R2 from "@alchemy.run/cloudflare/R2";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as wfp from "@distilled.cloud/cloudflare/workers_for_platforms";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Command from "alchemy/Command";
import * as Drift from "alchemy/Drift";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Stack } from "alchemy/Stack";
import { State } from "alchemy/State";
import { isResourceState } from "alchemy/State/State";
import { initialCwd } from "alchemy/Util/Node";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { stageSuffix, testName } from "../../names.ts";
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
import InitConfigWorker from "./fixtures/init-config-worker.ts";
import InternalWorker from "./fixtures/internal-worker.ts";
import OldCompatEffectWorker from "./fixtures/old-compat-effect-worker.ts";
import TerminalEffectWorker from "./fixtures/terminal-effect-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });
const { test: devTest } = Test.make({ providers: Cloudflare.providers(), dev: true });

// #1296: after precreate registers a Worker's Durable Object classes,
// reconcile's script-settings read can 404 "has no versions" under load, and
// migration planning then re-sends `new_sqlite_classes`, which Cloudflare
// rejects. The race isn't reproducible on demand, so this file-scoped
// provider stack forwards every call to the real API except the two
// settings reads after the precreated class is first observed.
const precreateRace = { hostPath: undefined as string | undefined, injected: 0 };
const settingsPath = /\/workers\/scripts\/[^/]+\/settings$/;
const precreateRaceFetch = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const path = new URL(request.url).pathname;
  if (request.method !== "GET" || !settingsPath.test(path)) {
    return fetch(input, init);
  }
  // Only the Durable Object host's own settings reads race.
  if (path === precreateRace.hostPath && precreateRace.injected < 2) {
    precreateRace.injected++;
    return new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 10007, message: "Worker has no versions" }],
        messages: [],
        result: null,
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  const response = await fetch(input, init);
  if (
    precreateRace.hostPath === undefined &&
    response.status === 200 &&
    (await response.clone().text()).includes('"namespace_id"')
  ) {
    precreateRace.hostPath = path;
  }
  return response;
};
const { test: precreateRaceTest } = Test.make({
  providers: Cloudflare.providers().pipe(
    Layer.provideMerge(
      Layer.fresh(FetchHttpClient.layer).pipe(
        Layer.provide(
          Layer.succeed(FetchHttpClient.Fetch, precreateRaceFetch as typeof globalThis.fetch),
        ),
      ),
    ),
  ),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const main = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");
const doMain = pathe.resolve(import.meta.dirname, "fixtures/do-counter-worker.ts");

describe.concurrent(
  "Cloudflare.Worker",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker"] },
  () => {
    test.provider(
      "create, update, delete worker",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const s = yield* Stack;

          yield* stack.destroy();

          const worker = yield* stack.deploy(
            Effect.gen(function* () {
              yield* R2.Bucket("Bucket", { forceDestroy: true, storageClass: "Standard" });

              const worker = yield* Cloudflare.Worker("TestWorker", {
                main,
                workersDev: true,
                compatibility: { date: "2024-01-01" },
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

          // The bundle that shipped is kept for inspection in the Worker's own
          // directory under `.alchemy/bundles`, named after stack, stage, and FQN.
          const fs = yield* FileSystem.FileSystem;
          const { dotAlchemy } = yield* AlchemyContext;
          const bundled = yield* fs.readDirectory(
            pathe.join(dotAlchemy, "bundles", `${s.name}-${s.stage}-TestWorker`),
          );
          expect(bundled.some((file) => file.endsWith(".js"))).toBe(true);

          // Verify the workers.dev subdomain is enabled on Cloudflare
          // (rather than just trusting the resource's output attributes).
          expect(worker.url).toBeDefined();
          const initialSubdomain = yield* workers.getScriptSubdomain({
            accountId,
            scriptName: worker.workerName,
          });
          expect(initialSubdomain).toEqual({ enabled: true, previewsEnabled: true });

          // Update the worker
          const updatedWorker = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("TestWorker", {
                main,
                workersDev: true,
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

          const actualUpdatedWorker = yield* findWorker(updatedWorker.workerName, accountId);
          expect(actualUpdatedWorker?.scriptName).toEqual(updatedWorker.workerName);
          const actualUpdatedSubdomain = yield* workers.getScriptSubdomain({
            accountId,
            scriptName: updatedWorker.workerName,
          });
          expect(actualUpdatedSubdomain).toEqual({ enabled: true, previewsEnabled: true });

          yield* stack.destroy();

          yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["provider:cloudflare:r2", "live"] },
    );

    test.provider(
      "zero-traffic upload receipts do not cause drift or hide live changes",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const program = (marker: string, traffic?: number) =>
            Cloudflare.Worker("ReceiptWorker", {
              script: `export default { fetch() { return new Response(${JSON.stringify(marker)}); } };`,
              workersDev: false,
              version: traffic === undefined ? undefined : { traffic },
            });

          // Establish a compatible live deployment before uploading the
          // candidate; a greenfield gradual rollout takes 100% of traffic.
          const stable = yield* stack.deploy(program("stable"));
          const beforeUpload = yield* workers.listScriptDeployments({
            accountId,
            scriptName: stable.workerName,
          });
          expect(beforeUpload.deployments[0]).toBeDefined();

          const candidate = yield* stack.deploy(program("candidate", 0));
          expect(candidate.workerName).toEqual(stable.workerName);
          expect(candidate.versionId).toBeDefined();
          expect(candidate.deploymentId).toBeUndefined();
          const uploaded = yield* workers.getScriptVersion({
            accountId,
            scriptName: candidate.workerName,
            versionId: candidate.versionId!,
          });
          expect(uploaded.id).toEqual(candidate.versionId);

          const detectDrift = () => Drift.detect(stack).pipe(Effect.provide(stack.state));
          const unchanged = yield* detectDrift();
          expect(unchanged.resources.ReceiptWorker?.action).toBe("unchanged");
          expect(unchanged.resources.ReceiptWorker?.attr.versionId).toEqual(candidate.versionId);

          const afterRead = yield* workers.listScriptDeployments({
            accountId,
            scriptName: candidate.workerName,
          });
          expect(afterRead.deployments[0]).toEqual(beforeUpload.deployments[0]);
          expect(
            afterRead.deployments[0]?.versions.some(
              (version) => version.versionId === candidate.versionId,
            ),
          ).toBe(false);

          // Change real script settings outside Alchemy. Keeping the upload
          // receipt must not mask genuine drift in the live configuration.
          yield* workers.createScriptSubdomain({
            accountId,
            scriptName: candidate.workerName,
            enabled: true,
            previewsEnabled: false,
          });
          const changed = yield* detectDrift();
          expect(changed.resources.ReceiptWorker?.action).toBe("drifted");
          expect(changed.resources.ReceiptWorker?.attr.versionId).toEqual(candidate.versionId);
          expect(changed.resources.ReceiptWorker?.attr.url).toBeDefined();

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(candidate.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 120_000 },
    );

    test.provider(
      "a full deploy reads back its deployment and does not drift",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const worker = yield* stack.deploy(
            Cloudflare.Worker("DeploymentWorker", {
              script: `export default { fetch() { return new Response("ok"); } };`,
              workersDev: false,
            }),
          );
          const { deployments } = yield* workers.listScriptDeployments({
            accountId,
            scriptName: worker.workerName,
          });
          expect(worker.deploymentId).toEqual(deployments[0]?.id);

          // `read` must return the recorded deployment, or every deployed
          // Worker compares unequal to state and reads as drifted.
          const detected = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
          expect(detected.resources.DeploymentWorker?.action).toBe("unchanged");
          expect(detected.resources.DeploymentWorker?.attr.deploymentId).toEqual(
            worker.deploymentId,
          );

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 120_000 },
    );

    // #1827: drift repair rebuilds the bundle from the `main` stored in
    // state. Deploy from one checkout with an absolute `main`
    // (`import.meta.url`), delete that checkout, then repair drift from
    // another checkout of the same code.
    test.provider(
      "drift repair rebuilds a Worker after the checkout that deployed it is gone",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const fs = yield* FileSystem.FileSystem;
          // Real path: on macOS the temp dir is a symlink, and `cwd` is real.
          const tempRoot = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-moved-checkout-" }),
          );
          const writeCheckout = (dir: string) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(pathe.join(dir, "src"), { recursive: true });
              yield* fs.writeFileString(
                pathe.join(dir, "package.json"),
                JSON.stringify({ name: "moved-checkout", private: true, type: "module" }),
              );
              yield* fs.writeFileString(
                pathe.join(dir, "src", "worker.ts"),
                `export default { fetch() { return new Response("moved-checkout"); } };\n`,
              );
            });
          const checkoutA = pathe.join(tempRoot, "checkout-a");
          const checkoutB = pathe.join(tempRoot, "checkout-b");
          yield* writeCheckout(checkoutA);
          const mainUrl = yield* Effect.sync(
            () => pathToFileURL(pathe.join(checkoutA, "src", "worker.ts")).href,
          );
          const originalCwd = yield* Effect.sync(() => process.cwd());

          yield* stack.destroy();

          const workerName = yield* Effect.gen(function* () {
            yield* Effect.sync(() => process.chdir(checkoutA));
            const worker = yield* stack.deploy(
              Cloudflare.Worker("MovedCheckoutWorker", { main: mainUrl, workersDev: true }),
            );

            // State keeps `main` relative to the deploying checkout.
            const row = yield* Effect.gen(function* () {
              const state = yield* yield* State;
              return yield* state.get({
                stack: stack.name,
                stage: stack.stage,
                fqn: "MovedCheckoutWorker",
              });
            }).pipe(Effect.provide(stack.state));
            expect((row as { props?: { main?: unknown } } | undefined)?.props?.main).toEqual(
              pathe.join("src", "worker.ts"),
            );

            // The deploying checkout is gone; another checkout repairs.
            yield* writeCheckout(checkoutB);
            yield* fs.remove(checkoutA, { recursive: true });
            yield* Effect.sync(() => process.chdir(checkoutB));

            yield* workers.createScriptSubdomain({
              accountId,
              scriptName: worker.workerName,
              enabled: false,
              previewsEnabled: false,
            });
            const repaired = yield* Drift.repair({ name: stack.name, stage: stack.stage }).pipe(
              Effect.provide(stack.state),
            );
            expect(repaired.resources.MovedCheckoutWorker).toMatchObject({ action: "repaired" });
            const subdomain = yield* workers.getScriptSubdomain({
              accountId,
              scriptName: worker.workerName,
            });
            expect(subdomain.enabled).toBe(true);
            return worker.workerName;
          }).pipe(Effect.ensuring(Effect.sync(() => process.chdir(originalCwd))));

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(workerName, accountId);
        }).pipe(Effect.scoped, logLevel),
      // mutates process-global cwd
      { tags: ["live"], timeout: 180_000, exclusive: true },
    );

    test.provider(
      "create, update, delete worker with assets",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const s = yield* Stack;

          yield* stack.destroy();

          const worker = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("TestWorkerWithAssets", {
                main,
                assets: pathe.resolve(import.meta.dirname, "assets"),
                workersDev: true,
                compatibility: { date: "2024-01-01" },
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
          expect(assetsWorkerSubdomain).toEqual({ enabled: true, previewsEnabled: true });

          // Update the worker
          const updatedWorker = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("TestWorkerWithAssets", {
                main,
                assets: pathe.resolve(import.meta.dirname, "assets"),
                workersDev: true,
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

          const actualUpdatedWorker = yield* findWorker(updatedWorker.workerName, accountId);
          expect(actualUpdatedWorker?.scriptName).toEqual(updatedWorker.workerName);
          expect(updatedWorker.hash?.assets).toBeDefined();

          // Final update
          const finalWorker = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("TestWorkerWithAssets", {
                main,
                workersDev: true,
                assets: pathe.resolve(import.meta.dirname, "assets"),
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

          yield* stack.destroy();

          yield* waitForWorkerToBeDeleted(finalWorker.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"] },
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
                  workersDev: true,
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
      { tags: ["live"], timeout: 360_000 },
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
                  workersDev: true,
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
      { tags: ["live"], timeout: 360_000 },
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
                  workersDev: true,
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
      { tags: ["live"], timeout: 360_000 },
    );

    test.provider(
      "create, update, delete internal worker",
      (stack) =>
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
      { tags: ["live"] },
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
      "refuses a foreign replacement without changing either Worker",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          yield* stack.destroy();
          const initial = yield* stack.deploy(
            Effect.gen(function* () {
              const owner = yield* Cloudflare.Worker("ReplacementOwner", {
                main,
                workersDev: false,
              });
              const replacement = yield* Cloudflare.Worker("ReplacementTarget", {
                main,
                workersDev: false,
              });
              return { owner, replacement };
            }),
          );
          const snapshot = Effect.all(
            [initial.owner, initial.replacement].map((worker) =>
              Effect.all({
                settings: workers.getScriptScriptAndVersionSetting({
                  accountId,
                  scriptName: worker.workerName,
                }),
                deployments: workers.listScriptDeployments({
                  accountId,
                  scriptName: worker.workerName,
                }),
              }),
            ),
          );
          const before = yield* snapshot;
          const refused = yield* stack
            .deploy(
              Effect.gen(function* () {
                yield* Cloudflare.Worker("ReplacementOwner", { main, workersDev: false });
                return yield* Cloudflare.Worker("ReplacementTarget", {
                  main,
                  workersDev: false,
                  name: initial.owner.workerName,
                });
              }),
            )
            .pipe(Effect.flip);
          expect(refused._tag).toEqual("OwnedBySomeoneElse");
          const after = yield* snapshot;
          expect(after).toEqual(before);
          // Destroy deletes ReplacementTarget's original generation and never
          // touches ReplacementOwner's script through the refused replacement.
          yield* stack.destroy();
          yield* Effect.all(
            [initial.owner, initial.replacement].map((worker) =>
              waitForWorkerToBeDeleted(worker.workerName, accountId),
            ),
          );
        }).pipe(logLevel),
      { tags: ["live"], timeout: 120000 },
    );

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
                workersDev: true,
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
            yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "AdoptableWorker" });
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
                workersDev: true,
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

          expect(adopted.workerName).toEqual(physicalName);

          const persisted = yield* Effect.gen(function* () {
            const state = yield* yield* State;
            return yield* state.get({
              stack: stack.name,
              stage: stack.stage,
              fqn: "AdoptableWorker",
            });
          }).pipe(Effect.provide(stack.state));

          expect(persisted?.status).toBeDefined();
          expect((persisted as any)?.attr).toMatchObject({ workerName: physicalName });

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(physicalName, accountId);
        }).pipe(logLevel),
      { tags: ["live"] },
    );

    test.provider(
      "adopt(true) takes over a foreign-tagged worker",
      (stack) =>
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
                workersDev: true,
                compatibility: { date: "2024-01-01" },
              });
            }),
          );
          const physicalName = original.workerName;
          expect(yield* findWorker(original.workerName, accountId)).toBeDefined();
          expect(yield* getWorkerTags(physicalName, accountId)).toContain("alchemy:id:Original");

          // Wipe state for the "Original" entry; the worker stays on Cloudflare.
          yield* Effect.gen(function* () {
            const state = yield* yield* State;
            yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "Original" });
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
                  workersDev: true,
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
      { tags: ["live"] },
    );

    // #1299: a binding to a resource created in the same deploy leaves the
    // Worker's props unresolved at plan time. The ownership check must still
    // run (at apply time, once props resolve) and refuse the foreign worker.
    test.provider(
      "refuses a foreign worker when its bindings are unresolved at plan time",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const original = yield* stack.deploy(
            Cloudflare.Worker("UnresolvedOriginal", {
              main,
              workersDev: false,
              compatibility: { date: "2024-01-01" },
            }),
          );
          const physicalName = original.workerName;

          yield* Effect.gen(function* () {
            const state = yield* yield* State;
            yield* state.delete({
              stack: stack.name,
              stage: stack.stage,
              fqn: "UnresolvedOriginal",
            });
          }).pipe(Effect.provide(stack.state));

          const refused = yield* stack
            .deploy(
              Effect.gen(function* () {
                const kv = yield* Cloudflare.KV.Namespace("UnresolvedKv");
                return yield* Cloudflare.Worker("UnresolvedDifferent", {
                  main,
                  name: physicalName,
                  workersDev: false,
                  compatibility: { date: "2024-01-01" },
                  env: { KV: kv },
                });
              }),
            )
            .pipe(Effect.flip);
          expect(refused._tag).toEqual("OwnedBySomeoneElse");

          // The refused deploy left the foreign worker's ownership untouched.
          const tags = yield* getWorkerTags(physicalName, accountId);
          expect(tags).toContain("alchemy:id:UnresolvedOriginal");
          expect(tags).not.toContain("alchemy:id:UnresolvedDifferent");

          // Its tags still name `UnresolvedOriginal`, so redeploying that id
          // adopts it back into state and the destroy below deletes it.
          yield* stack.deploy(
            Cloudflare.Worker("UnresolvedOriginal", {
              main,
              name: physicalName,
              workersDev: false,
              compatibility: { date: "2024-01-01" },
            }),
          );
          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(physicalName, accountId);
        }).pipe(logLevel),
      { tags: ["live"] },
    );

    // #2198: unresolved props bypass the plan probe, and the self-binding forces
    // precreate. A binding-only cycle with resolved props would not test this path.
    for (const scopedAdopt of [undefined, false]) {
      test.provider(
        `cyclic precreate refuses a foreign Worker with scoped adoption ${scopedAdopt}`,
        (stack) =>
          Effect.gen(function* () {
            const { accountId } = yield* yield* CloudflareEnvironment;
            yield* stack.destroy();
            const original = yield* stack.deploy(
              Cloudflare.Worker("CyclicOriginal", { main, workersDev: false }),
            );
            const request = { accountId, scriptName: original.workerName };
            const settings = yield* workers.getScriptScriptAndVersionSetting(request);
            const deployment = yield* workers.listScriptDeployments(request);
            yield* Effect.gen(function* () {
              const state = yield* yield* State;
              yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "CyclicOriginal" });
            }).pipe(Effect.provide(stack.state));

            const program = Effect.gen(function* () {
              const kv = yield* Cloudflare.KV.Namespace("CyclicKv");
              const declaration = Cloudflare.Worker("CyclicDifferent", {
                main,
                name: original.workerName,
                workersDev: false,
                env: { KV: kv },
              });
              const worker = yield* scopedAdopt === undefined
                ? declaration
                : declaration.pipe(adopt(scopedAdopt));
              yield* worker.bind`SELF_NAME`({
                bindings: [{ type: "plain_text", name: "SELF_NAME", text: worker.workerName }],
              });
              return worker;
            });
            const plan = yield* stack.plan(program);
            expect(plan.resources.CyclicDifferent?.action).toBe("create");
            const refused = yield* stack.deploy(program).pipe(
              Effect.as(false),
              Effect.catchTag("OwnedBySomeoneElse", (error) => {
                expect(error).toBeInstanceOf(OwnedBySomeoneElse);
                return Effect.succeed(true);
              }),
            );
            expect(refused).toBe(true);
            const checkpoint = yield* Effect.gen(function* () {
              const state = yield* yield* State;
              return yield* state.get({
                stack: stack.name,
                stage: stack.stage,
                fqn: "CyclicDifferent",
              });
            }).pipe(Effect.provide(stack.state));
            // Refused before precreate's attributes were checkpointed.
            expect(checkpoint?.status).toBe("creating");
            if (isResourceState(checkpoint)) expect(checkpoint.attr).toBeUndefined();
            // Verify both configuration and active code remain unchanged, not just tags.
            expect(yield* workers.getScriptScriptAndVersionSetting(request)).toEqual(settings);
            expect(yield* workers.listScriptDeployments(request)).toEqual(deployment);
            yield* stack.destroy();
            expect(yield* workers.listScriptDeployments(request)).toEqual(deployment);

            // Restore only the original logical owner so normal stack cleanup removes it.
            yield* stack.deploy(
              Cloudflare.Worker("CyclicOriginal", {
                main,
                name: original.workerName,
                workersDev: false,
              }),
            );
            yield* stack.destroy();
            yield* waitForWorkerToBeDeleted(original.workerName, accountId);
          }).pipe(adopt(scopedAdopt === false), logLevel),
        { tags: ["live"], timeout: 120_000 },
      );
    }

    test.provider(
      "cyclic precreate permits resource-scoped adoption of a foreign Worker",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          yield* stack.destroy();
          const original = yield* stack.deploy(
            Cloudflare.Worker("CyclicAdoptOriginal", { main, workersDev: false }),
          );
          yield* Effect.gen(function* () {
            const state = yield* yield* State;
            yield* state.delete({
              stack: stack.name,
              stage: stack.stage,
              fqn: "CyclicAdoptOriginal",
            });
          }).pipe(Effect.provide(stack.state));
          const program = Effect.gen(function* () {
            const kv = yield* Cloudflare.KV.Namespace("CyclicAdoptKv");
            const worker = yield* Cloudflare.Worker("CyclicAdoptDifferent", {
              main,
              name: original.workerName,
              workersDev: false,
              env: { KV: kv },
            }).pipe(adopt(true));
            yield* worker.bind`SELF_NAME`({
              bindings: [{ type: "plain_text", name: "SELF_NAME", text: worker.workerName }],
            });
            return worker;
          });
          expect((yield* stack.plan(program)).resources.CyclicAdoptDifferent?.action).toBe(
            "create",
          );
          const adopted = yield* stack.deploy(program);
          expect(adopted.workerName).toBe(original.workerName);
          const tags = yield* getWorkerTags(adopted.workerName, accountId);
          expect(tags).toContain("alchemy:id:CyclicAdoptDifferent");
          expect(tags).not.toContain("alchemy:id:CyclicAdoptOriginal");
          const settings = yield* workers.getScriptScriptAndVersionSetting({
            accountId,
            scriptName: adopted.workerName,
          });
          expect(settings.bindings).toContainEqual(
            expect.objectContaining({
              type: "plain_text",
              name: "SELF_NAME",
              text: adopted.workerName,
            }),
          );
          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(adopted.workerName, accountId);
        }).pipe(adopt(false), logLevel),
      { tags: ["live"], timeout: 120_000 },
    );

    /**
     * A cyclic Worker named `name` in `namespace`. A KV namespace created in
     * the same deploy keeps its props unresolved, so `read` cannot run before
     * precreate; the self-binding puts it in a cycle.
     */
    const cyclicWorker = (name: string, namespace: string) =>
      Effect.gen(function* () {
        const kv = yield* Cloudflare.KV.Namespace("CyclicKv");
        const worker = yield* Cloudflare.Worker("CyclicDifferent", {
          main,
          name,
          namespace,
          workersDev: false,
          env: { KV: kv },
        });
        yield* worker.bind`SELF_NAME`({
          bindings: [{ type: "plain_text", name: "SELF_NAME", text: worker.workerName }],
        });
        return worker;
      });

    /**
     * Forgets `fqn`, leaving its script owned by another logical id. Returns a
     * step that remembers it again, so destroy removes it through normal
     * stack cleanup.
     */
    const forget = Effect.fn(function* (stack: Test.ScratchStack, fqn: string) {
      const key = { stack: stack.name, stage: stack.stage, fqn };
      const row = yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const value = yield* state.get(key);
        yield* state.delete(key);
        return value!;
      }).pipe(Effect.provide(stack.state));
      return Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.set({ ...key, value: row });
      }).pipe(Effect.provide(stack.state));
    });

    const scriptName = (stack: Test.ScratchStack, suffix: string) =>
      `alchemy-cyclic-${suffix}-${stack.stage}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    // #2194: an interrupted create stores its props without the ones that were
    // still unresolved. A namespace stripped that way leaves `{ name }`, which
    // a recovery lookup resolves to the account-level script of that name.
    // Destroy must not delete that script: the attempt never targeted it.
    test.provider(
      "destroy never recovers an interrupted create from props missing its namespace",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          yield* stack.destroy();
          const name = scriptName(stack, "provenance");
          // An account-level script tagged for `Api`, unknown to state.
          yield* stack.deploy(Cloudflare.Worker("Api", { main, name, workersDev: false }));
          const restore = yield* forget(stack, "Api");
          const deployments = () => workers.listScriptDeployments({ accountId, scriptName: name });
          const before = yield* deployments();

          // `Api` waits on a Worker whose upload fails, so its create stops
          // with the namespace still unresolved and no attributes recorded.
          const error = yield* stack
            .deploy(
              Effect.gen(function* () {
                const tenant = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace(
                  "ProvenanceTenant",
                  { name: scriptName(stack, "provenance-ns") },
                );
                const broken = yield* Cloudflare.Worker("Broken", {
                  script: "export default {",
                  workersDev: false,
                });
                return yield* Cloudflare.Worker("Api", {
                  main,
                  name,
                  namespace: tenant.name,
                  env: { BROKEN: broken.workerName },
                });
              }),
            )
            .pipe(Effect.flip);
          expect(error).toBeDefined();
          const checkpoint = yield* Effect.gen(function* () {
            const state = yield* yield* State;
            return yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "Api" });
          }).pipe(Effect.provide(stack.state));
          expect(checkpoint).toMatchObject({ status: "creating", propsIncomplete: true });
          if (isResourceState(checkpoint)) {
            expect(checkpoint.attr).toBeUndefined();
            expect(checkpoint.props).not.toHaveProperty("namespace");
          }

          yield* stack.destroy();
          // The account-level script survived the destroy, untouched.
          expect(yield* deployments()).toEqual(before);

          yield* restore;
          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(name, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 180_000 },
    );

    test.provider(
      "a cyclic dispatch-namespace Worker refuses a foreign script in its namespace",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          yield* stack.destroy();
          const namespaceName = scriptName(stack, "ns");
          const name = scriptName(stack, "user");
          const namespace = Cloudflare.WorkersForPlatforms.DispatchNamespace("CyclicNamespace", {
            name: namespaceName,
          });
          // The namespace first: reading a script in a namespace that does not
          // exist yet fails with an unknown error.
          yield* stack.deploy(namespace);
          yield* stack.deploy(
            Effect.gen(function* () {
              yield* namespace;
              return yield* Cloudflare.Worker("CyclicOriginal", {
                main,
                name,
                namespace: namespaceName,
              });
            }),
          );
          const restore = yield* forget(stack, "CyclicOriginal");
          const request = { accountId, dispatchNamespace: namespaceName, scriptName: name };
          const before = yield* wfp.getDispatchNamespaceScript(request);

          // A literal namespace is resolved, so `observe` can check the script in it.
          const program = Effect.gen(function* () {
            yield* namespace;
            return yield* cyclicWorker(name, namespaceName);
          });
          const error = yield* stack.deploy(program).pipe(Effect.flip);
          expect(error).toMatchObject({ _tag: "OwnedBySomeoneElse", logicalId: "CyclicDifferent" });
          expect((yield* wfp.getDispatchNamespaceScript(request)).modifiedOn).toBe(
            before.modifiedOn,
          );

          // Remember the original before the namespace goes, so destroy deletes its script first.
          yield* restore;
          yield* stack.destroy();
        }).pipe(logLevel),
      { tags: ["live"], timeout: 180_000 },
    );

    // #2540: a cyclic Worker whose namespace is still unresolved precreates a
    // stub that claims nothing. Its script must be checked once the namespace
    // resolves, before reconcile uploads over a foreign script there.
    test.provider(
      "a cyclic Worker refuses a foreign script in a namespace that resolves during apply",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          yield* stack.destroy();
          const namespaceName = scriptName(stack, "late-ns");
          const name = scriptName(stack, "late-user");
          const namespace = Cloudflare.WorkersForPlatforms.DispatchNamespace("LateNamespace", {
            name: namespaceName,
          });
          yield* stack.deploy(namespace);
          yield* stack.deploy(
            Effect.gen(function* () {
              yield* namespace;
              return yield* Cloudflare.Worker("LateOriginal", {
                main,
                name,
                namespace: namespaceName,
              });
            }),
          );
          const restore = yield* forget(stack, "LateOriginal");
          const request = { accountId, dispatchNamespace: namespaceName, scriptName: name };
          const before = yield* wfp.getDispatchNamespaceScript(request);

          const program = Effect.gen(function* () {
            const ns = yield* namespace;
            const kv = yield* Cloudflare.KV.Namespace("LateKv");
            const worker = yield* Cloudflare.Worker("LateDifferent", {
              main,
              name,
              // Resolves only once `LateKv` is created, after the cycle precreates.
              namespace: Output.all(ns.name, kv.namespaceId).pipe(Output.map(([name]) => name)),
              workersDev: false,
              env: { KV: kv },
            });
            yield* worker.bind`SELF_NAME`({
              bindings: [{ type: "plain_text", name: "SELF_NAME", text: worker.workerName }],
            });
            return worker;
          });
          const error = yield* stack.deploy(program).pipe(Effect.flip);
          expect(error).toMatchObject({ _tag: "OwnedBySomeoneElse", logicalId: "LateDifferent" });
          expect((yield* wfp.getDispatchNamespaceScript(request)).modifiedOn).toBe(
            before.modifiedOn,
          );
          const checkpoint = yield* Effect.gen(function* () {
            const state = yield* yield* State;
            return yield* state.get({
              stack: stack.name,
              stage: stack.stage,
              fqn: "LateDifferent",
            });
          }).pipe(Effect.provide(stack.state));
          // The stub claimed nothing, so a retry checks the script again.
          expect(checkpoint?.status).toBe("creating");
          if (isResourceState(checkpoint)) expect(checkpoint.attr).toBeUndefined();

          // Remember the original before the namespace goes, so destroy deletes its script first.
          yield* restore;
          yield* stack.destroy();
        }).pipe(logLevel),
      { tags: ["live"], timeout: 180_000 },
    );

    // #2533: a cyclic dispatch-namespace Worker precreates a stub that uploads
    // nothing. Its namespace comes from outside the cycle, so it resolves
    // before precreate and the stub records it. When the upload then fails,
    // destroy must not read that as an account-level Worker and delete the
    // same-name script there.
    test.provider(
      "destroy preserves the account Worker after an interrupted dispatch precreate",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          yield* stack.destroy();
          const name = scriptName(stack, "stub-cleanup");
          // An account-level script tagged for `Api`, unknown to state.
          yield* stack.deploy(Cloudflare.Worker("Api", { main, name, workersDev: false }));
          const restore = yield* forget(stack, "Api");
          yield* Effect.gen(function* () {
            const deployments = () =>
              workers.listScriptDeployments({ accountId, scriptName: name });
            const before = yield* deployments();
            // The namespace derives from a new output and doesn't exist, so
            // the dispatch upload fails after precreate wrote its stub.
            const error = yield* stack
              .deploy(
                Effect.gen(function* () {
                  const late = yield* Cloudflare.KV.Namespace("StubScopeMarker");
                  const worker = yield* Cloudflare.Worker("Api", {
                    main,
                    name,
                    namespace: Output.map(late.namespaceId, () =>
                      scriptName(stack, "unavailable-ns"),
                    ),
                    env: { KV: late },
                  });
                  yield* worker.bind`SELF_NAME`({
                    bindings: [{ type: "plain_text", name: "SELF_NAME", text: worker.workerName }],
                  });
                  return worker;
                }),
              )
              .pipe(Effect.flip);
            expect(error).toBeDefined();
            const checkpoint = yield* Effect.gen(function* () {
              const state = yield* yield* State;
              return yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "Api" });
            }).pipe(Effect.provide(stack.state));
            expect(checkpoint).toMatchObject({ status: "creating" });
            if (!isResourceState(checkpoint))
              return yield* Effect.die("Missing resource checkpoint");
            expect(checkpoint.attr).toMatchObject({
              workerId: "",
              namespace: scriptName(stack, "unavailable-ns"),
            });
            expect(yield* deployments()).toEqual(before);

            yield* stack.destroy();
            // The account-level script survived the destroy, untouched.
            expect(yield* deployments()).toEqual(before);
          }).pipe(Effect.ensuring(restore.pipe(Effect.andThen(stack.destroy()), Effect.orDie)));
          yield* waitForWorkerToBeDeleted(name, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 180_000 },
    );

    // First-deploy behaviour: the default (omitting `workersDev`) must enable
    // the workers.dev subdomain, and `workersDev: false` must disable it. Both
    // are asserted against live Cloudflare state via `getScriptSubdomain`,
    // not just the resource's output attributes.
    test.provider(
      "workersDev defaults to enabling the workers.dev subdomain on first deploy",
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

          // Default: url = the stable workers.dev URL = allUrls[0], and
          // domains mirrors allUrls as bare hostnames.
          expect(worker.url).toMatch(
            new RegExp(`^https://${worker.workerName}\\..*\\.workers\\.dev$`),
          );
          expect(worker.urls).toEqual([worker.url]);
          expect(worker.domain).toBeUndefined();
          yield* expectWorkersDevSubdomain(worker.workerName, accountId, true);

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"] },
    );

    test.provider(
      "workersDev: false disables the workers.dev subdomain on first deploy",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const worker = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("SubdomainDisabledWorker", {
                main,
                workersDev: false,
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

          expect(worker.url).toBeUndefined();
          expect(worker.urls).toEqual([]);
          expect(worker.domain).toBeUndefined();
          yield* expectWorkersDevSubdomain(worker.workerName, accountId, false);

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"] },
    );

    // Update regression: toggling `workersDev` between deploys must propagate
    // to the live Cloudflare subdomain state. Before this regression
    // was fixed, the reconciler diffed the props symmetrically — but the
    // observed-vs-desired check inside reconcile must still flip the toggle
    // when props really do change.
    test.provider(
      "toggling workersDev between deploys flips the workers.dev subdomain",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const deploy = (workersDev: boolean) =>
            stack.deploy(
              Effect.gen(function* () {
                return yield* Cloudflare.Worker("SubdomainToggleWorker", {
                  main,
                  workersDev,
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
      { tags: ["live"] },
    );

    // `workersDev: { enabled: false, previewsEnabled: true }` — a "preview-only" worker.
    // The stable workers.dev URL is off, so the current version's preview URL
    // (`https://<version-prefix>-<name>.<account>.workers.dev`) becomes the
    // primary `url` output.
    test.provider(
      "workersDev previews-only surfaces the version preview URL as url",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const worker = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("PreviewOnlyWorker", {
                main,
                workersDev: { enabled: false, previewsEnabled: true },
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

          yield* expectWorkersDevPreviews(worker.workerName, accountId, {
            enabled: false,
            previewsEnabled: true,
          });
          // The preview URL is version-scoped: an 8-char version prefix in
          // front of the worker name.
          expect(worker.url).toMatch(
            new RegExp(`^https://[0-9a-f]{8}-${worker.workerName}\\..*\\.workers\\.dev$`),
          );
          expect(worker.urls).toEqual([worker.url]);
          expect(worker.domain).toBeUndefined();

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"] },
    );

    // Dev mode: no workers.dev or custom-domain URLs exist, so the local dev
    // server's localhost URL leads `allUrls` and is the `url`.
    devTest.provider(
      "dev mode: url is the local dev server URL",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const worker = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("LocalUrlWorker", {
                main,
                dev: { port: 0 },
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

          expect(worker.url).toMatch(/^http:\/\/localhost:\d+$/);
          expect(worker.urls[0]).toEqual(worker.url);
          expect(new URL(worker.urls[0]).hostname).toEqual("localhost");
          expect(worker.domain).toBeUndefined();

          // The URL actually serves the local worker.
          yield* expectUrlContains(`${worker.url}/`, "Hello from TestWorker", {
            timeout: "30 seconds",
            label: "local dev worker",
          });

          yield* stack.destroy();
        }).pipe(logLevel),
      { tags: ["local"] },
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
              Cloudflare.Worker("SubdomainPreviewsDriftWorker", { main, compatibility: { date } }),
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
      { tags: ["live"] },
    );

    // `process.stdin` is undefined on compatibility dates before Node.js
    // process v2, so an Effect Worker's platform services must not read it
    // while the Worker starts.
    for (const [label, worker, dev] of [
      ["live", test, false],
      ["dev", devTest, true],
    ] as const) {
      worker.provider(
        `Effect Worker serves on a compatibility date without process.stdin (${label})`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const deployed = yield* stack.deploy(OldCompatEffectWorker);
            yield* expectUrlContains(deployed.url!, "Hello from an old compatibility date", {
              label: `old compatibility date (${label})`,
            });
            yield* stack.destroy();
          }).pipe(logLevel),
        { tags: [dev ? "local" : "live"] },
      );

      // ...while on later dates, where `process.stdin` exists, handlers
      // still get the `Terminal` service.
      worker.provider(
        `Effect Worker on a current compatibility date still provides Terminal (${label})`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const deployed = yield* stack.deploy(TerminalEffectWorker);
            yield* expectUrlContains(deployed.url!, "Terminal provided (number)", {
              label: `Terminal on a current compatibility date (${label})`,
            });
            yield* stack.destroy();
          }).pipe(logLevel),
        { tags: [dev ? "local" : "live"] },
      );
    }

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

          const v1 = yield* stack.deploy(program({ flags: [], observability: false }));

          // Identical props → noop.
          const stablePlan = yield* stack.plan(program({ flags: [], observability: false }));
          expect(actionOf(stablePlan, "MetadataOnlyWorker")).toBe("noop");

          // A compatibility-flag-only change must plan as an update ...
          const flagPlan = yield* stack.plan(
            program({ flags: ["nodejs_als"], observability: false }),
          );
          expect(actionOf(flagPlan, "MetadataOnlyWorker")).toBe("update");

          // ... and the deploy must apply it to the live script settings.
          const v2 = yield* stack.deploy(program({ flags: ["nodejs_als"], observability: false }));
          expect(v2.workerName).toEqual(v1.workerName);
          const flagSettings = yield* workers.getScriptScriptAndVersionSetting({
            accountId,
            scriptName: v2.workerName,
          });
          expect(flagSettings.compatibilityFlags).toContain("nodejs_als");

          // Same for an observability-only change. The bundle hash must not
          // move — proof the update decision came from the metadata hash alone,
          // not from an incidental rebuild.
          const v3 = yield* stack.deploy(program({ flags: ["nodejs_als"], observability: true }));
          expect(v3.hash?.bundle).toEqual(v2.hash?.bundle);
          const observabilitySettings = yield* workers.getScriptScriptAndVersionSetting({
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
      { tags: ["live"], timeout: 360_000 },
    );

    // Cloudflare keeps a `secret_text` binding that a script upload omits, so
    // a secret removed from `env` stayed bound to the deployed Worker. The
    // cleanup must not touch a secret set outside Alchemy.
    test.provider(
      "a secret removed from env is unbound; one set outside Alchemy is kept",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const program = (env: Record<string, Redacted.Redacted<string>>) =>
            Cloudflare.Worker("RemovedSecretWorker", { main, env });
          const secretBindings = (scriptName: string) =>
            workers.getScriptScriptAndVersionSetting({ accountId, scriptName }).pipe(
              Effect.map((settings) =>
                (settings.bindings ?? [])
                  .filter((binding) => binding.type === "secret_text")
                  .map((binding) => binding.name)
                  .sort(),
              ),
            );

          const v1 = yield* stack.deploy(
            program({ DROPPED: Redacted.make("dropped"), KEPT: Redacted.make("kept") }),
          );
          expect(yield* secretBindings(v1.workerName)).toEqual(["DROPPED", "KEPT"]);
          yield* workers.putScriptSecret({
            accountId,
            scriptName: v1.workerName,
            name: "OUTSIDE",
            text: "set-outside-alchemy",
            type: "secret_text",
          });

          const v2 = yield* stack.deploy(program({ KEPT: Redacted.make("kept") }));
          expect(yield* secretBindings(v2.workerName)).toEqual(["KEPT", "OUTSIDE"]);
          expect(v2.secretNames).toEqual(["KEPT"]);

          const settledPlan = yield* stack.plan(program({ KEPT: Redacted.make("kept") }));
          const action = Object.values(settledPlan.resources).find(
            (node) => node.resource.LogicalId === "RemovedSecretWorker",
          )?.action;
          expect(action).toBe("noop");

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 240_000 },
    );

    test.provider(
      "Issues survive code redeploys and can be disabled or removed",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          yield* stack.destroy();

          const observability = {
            enabled: true,
            headSamplingRate: 0.5,
            logs: { enabled: true, invocationLogs: true, headSamplingRate: 0, persist: false },
            traces: { enabled: false, headSamplingRate: 0.1, persist: false },
          };
          let original: workers.GetScriptScriptAndVersionSettingResponse | undefined;
          let scriptName = "";
          let tailName = "";
          for (const [issues, version] of [
            [true, "v1"],
            [true, "v2"],
            [false, "v2"],
            [true, "v2"],
            [undefined, "v2"],
          ] as const) {
            const { worker, tail } = yield* stack.deploy(
              Effect.gen(function* () {
                const tail = yield* Cloudflare.Worker("IssuesTail", {
                  script: "export default { tail() {} };",
                  bundle: false,
                });
                const worker = yield* Cloudflare.Worker("IssuesWorker", {
                  script: `export default { fetch() { return new Response("${version}"); } };`,
                  bundle: false,
                  logpush: true,
                  tags: ["issues-preservation"],
                  tailConsumers: [tail],
                  compatibility: { date: "2024-01-01", flags: ["nodejs_als"] },
                  limits: { cpuMs: 50 },
                  env: { PRESERVED: "issues-preservation" },
                  observability: {
                    ...observability,
                    issues: issues === undefined ? undefined : { enabled: issues },
                  },
                });
                return { worker, tail };
              }),
            );
            tailName = tail.workerName;
            if (scriptName) expect(worker.workerName).toBe(scriptName);
            scriptName = worker.workerName;

            const settings = yield* workers.getScriptScriptAndVersionSetting({
              accountId,
              scriptName,
            });
            expect(settings.observability?.issues?.enabled ?? false).toBe(issues ?? false);
            expect(settings.observability?.enabled).toBe(true);
            expect(settings.observability?.headSamplingRate).toBe(0.5);
            expect(settings.observability?.logs).toMatchObject(observability.logs);
            expect(settings.observability?.traces).toMatchObject(observability.traces);
            expect(settings.logpush).toBe(true);
            expect(settings.tags).toContain("issues-preservation");
            expect(settings.tailConsumers).toEqual([{ service: tailName }]);
            expect(settings.compatibilityDate).toBe("2024-01-01");
            expect(settings.compatibilityFlags).toEqual(["nodejs_als"]);
            expect(settings.limits).toMatchObject({ cpuMs: 50 });
            expect(settings.bindings).toContainEqual({
              type: "plain_text",
              name: "PRESERVED",
              text: "issues-preservation",
            });
            const unchanged = {
              ...settings,
              observability: { ...settings.observability!, issues: undefined },
            };
            if (original) expect(unchanged).toEqual(original);
            else original = unchanged;
            yield* expectUrlContains(worker.url!, version, { timeout: "30 seconds" });
          }
          // Exercise PATCH explicitly: a successful upload can make the fallback unnecessary.
          for (const enabled of [true, false]) {
            yield* workers.patchScriptSetting({
              accountId,
              scriptName,
              observability: {
                ...observability,
                redactQueryString: true,
                issues: { enabled },
              },
            });
            const patched = yield* workers.getScriptScriptAndVersionSetting({
              accountId,
              scriptName,
            });
            expect(patched.observability?.issues?.enabled).toBe(enabled);
            expect({
              ...patched,
              observability: { ...patched.observability, issues: undefined },
            }).toEqual({
              ...original,
              observability: { ...original!.observability, redactQueryString: true },
            });
          }

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(scriptName, accountId);
          yield* waitForWorkerToBeDeleted(tailName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 120_000 },
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

          class EnvTagTarget extends Cloudflare.Worker<EnvTagTarget, {}>()("EnvTagTargetWorker") {}
          class EnvTagCaller extends Cloudflare.Worker<EnvTagCaller, {}>()("EnvTagCallerWorker") {}

          // The caller's entry lives in a temp dir so the test can edit its
          // contents mid-flight without touching the shared checked-in fixture.
          const callerScript = (marker: string) =>
            `export default { fetch: async () => new Response(${JSON.stringify(marker)}) };\n`;
          const tempDir = yield* fs.makeTempDirectory({ prefix: "alchemy-env-tag-worker" });
          const callerMain = path.join(tempDir, "worker.ts");
          yield* fs.writeFileString(callerMain, callerScript("v1"));

          const layers = Layer.mergeAll(
            EnvTagTarget.make({ main, isExternal: true }, Effect.succeed({})),
            EnvTagCaller.make(
              { main: callerMain, isExternal: true, env: { TARGET: EnvTagTarget } },
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
      { tags: ["live"], timeout: 360_000 },
    );

    // #1272 regression, remaining #874 case: an already-yielded Worker is
    // plain resource attributes rather than an Effect-valued tag. In a binding
    // chain, plan and apply may materialize different stable/full projections
    // of those attributes, but both describe the same service binding and must
    // converge.
    // Switching the actual target must still update the caller and land in
    // Cloudflare.
    test.provider(
      "nested yielded worker resources in env converge to noop plans",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const program = (selected: "A" | "B") =>
            Effect.gen(function* () {
              const targetB = yield* Cloudflare.Worker("YieldedEnvTargetB", { main });
              const targetA = yield* Cloudflare.Worker("YieldedEnvTargetA", {
                main,
                env: { UPSTREAM: targetB },
              });
              const caller = yield* Cloudflare.Worker("YieldedEnvCaller", {
                main,
                env: { TARGET: selected === "A" ? targetA : targetB },
              });
              return { targetA, targetB, caller };
            });

          const actionOf = (plan: any, logicalId: string) =>
            (Object.values(plan.resources) as any[]).find(
              (node: any) => node.resource.LogicalId === logicalId,
            )?.action;

          const deployedA = yield* stack.deploy(program("A"));
          const bindingTarget = Effect.fn(function* (callerName: string) {
            const settings = yield* workers.getScriptScriptAndVersionSetting({
              accountId,
              scriptName: callerName,
            });
            return settings.bindings?.find(
              (binding) => binding.type === "service" && binding.name === "TARGET",
            );
          });
          expect(yield* bindingTarget(deployedA.caller.workerName)).toEqual(
            expect.objectContaining({
              type: "service",
              name: "TARGET",
              service: deployedA.targetA.workerName,
            }),
          );

          const stableA = yield* stack.plan(program("A"));
          expect(actionOf(stableA, "YieldedEnvTargetA")).toBe("noop");
          expect(actionOf(stableA, "YieldedEnvTargetB")).toBe("noop");
          expect(actionOf(stableA, "YieldedEnvCaller")).toBe("noop");

          const switchPlan = yield* stack.plan(program("B"));
          expect(actionOf(switchPlan, "YieldedEnvTargetA")).toBe("noop");
          expect(actionOf(switchPlan, "YieldedEnvTargetB")).toBe("noop");
          expect(actionOf(switchPlan, "YieldedEnvCaller")).toBe("update");

          const deployedB = yield* stack.deploy(program("B"));
          expect(yield* bindingTarget(deployedB.caller.workerName)).toEqual(
            expect.objectContaining({
              type: "service",
              name: "TARGET",
              service: deployedB.targetB.workerName,
            }),
          );

          const stableB = yield* stack.plan(program("B"));
          expect(actionOf(stableB, "YieldedEnvTargetA")).toBe("noop");
          expect(actionOf(stableB, "YieldedEnvTargetB")).toBe("noop");
          expect(actionOf(stableB, "YieldedEnvCaller")).toBe("noop");

          yield* stack.destroy();
          yield* Effect.all(
            [
              deployedB.caller.workerName,
              deployedB.targetA.workerName,
              deployedB.targetB.workerName,
            ].map((name) => waitForWorkerToBeDeleted(name, accountId)),
            { concurrency: "unbounded" },
          );
        }).pipe(logLevel),
      { tags: ["live"], timeout: 360_000 },
    );

    // Precreate publishes the URLs known before the first upload, so a cycle
    // of Workers binding each other's `url` resolves on the first deploy.
    // Worker A serves only on a custom domain (`workersDev: false`): its
    // precreate `url` must be the domain, not `undefined`.
    const circularUrlZone =
      process.env.CLOUDFLARE_TEST_WORKER_DOMAIN_ZONE_NAME ?? "alchemy-test-2.us";
    test.provider(
      "circular Worker URL bindings resolve custom-domain and workers.dev URLs on the first deploy",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const suffix = stageSuffix();
          const domainA = `alchemy-circular-url-${suffix}.${circularUrlZone}`;

          yield* stack.destroy();

          const program = () =>
            Effect.gen(function* () {
              const a = yield* Cloudflare.Worker("CircularUrlA", {
                main,
                workersDev: false,
                domain: domainA,
              });
              const b = yield* Cloudflare.Worker("CircularUrlB", { main });
              yield* a.bind`B_URL`({
                bindings: [
                  {
                    type: "plain_text",
                    name: "B_URL",
                    text: b.url.as<string>(),
                  },
                ],
              });
              yield* b.bind`A_URL`({
                bindings: [
                  {
                    type: "plain_text",
                    name: "A_URL",
                    text: a.url.as<string>(),
                  },
                ],
              });
              return { a, b };
            });

          const deployed = yield* stack.deploy(program());
          expect(deployed.a.url).toEqual(`https://${domainA}`);
          expect(deployed.b.url).toMatch(/^https:\/\/.*\.workers\.dev$/);
          for (const [worker, name, peerUrl] of [
            [deployed.a, "B_URL", deployed.b.url],
            [deployed.b, "A_URL", deployed.a.url],
          ] as const) {
            const settings = yield* workers.getScriptScriptAndVersionSetting({
              accountId,
              scriptName: worker.workerName,
            });
            expect(settings.bindings).toContainEqual(
              expect.objectContaining({
                type: "plain_text",
                name,
                text: peerUrl,
              }),
            );
          }

          const settled = yield* stack.plan(program());
          for (const logicalId of ["CircularUrlA", "CircularUrlB"]) {
            const node = (Object.values(settled.resources) as any[]).find(
              (candidate) => candidate.resource.LogicalId === logicalId,
            );
            expect(node?.action).toBe("noop");
          }

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(deployed.a.workerName, accountId);
          yield* waitForWorkerToBeDeleted(deployed.b.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 360_000 },
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

          class CircTagA extends Cloudflare.Worker<CircTagA, {}>()("CircTagAWorker") {}
          class CircTagB extends Cloudflare.Worker<CircTagB, {}>()("CircTagBWorker") {}

          const layers = Layer.mergeAll(
            CircTagA.make({ main, isExternal: true, env: { PEER: CircTagB } }, Effect.succeed({})),
            CircTagB.make({ main, isExternal: true, env: { PEER: CircTagA } }, Effect.succeed({})),
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
              expect.objectContaining({ type: "service", name: "PEER", service: peer.workerName }),
            );
          }

          const settled = yield* stack.plan(program());
          expect(actionOf(settled, "CircTagAWorker")).toBe("noop");
          expect(actionOf(settled, "CircTagBWorker")).toBe("noop");

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(deployed.a.workerName, accountId);
          yield* waitForWorkerToBeDeleted(deployed.b.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 360_000 },
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
              const source = yield* Cloudflare.Worker("BindTextSource", { main });
              const host = yield* Cloudflare.Worker("BindTextHost", { main });
              // `source.workerName` is an Output<string> at plan time — the
              // same shape as an Action-produced value bound as plain_text.
              yield* host.bind`REV`({
                bindings: [{ type: "plain_text", name: "REV", text: source.workerName }],
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
      { tags: ["live"], timeout: 360_000 },
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
            expect.objectContaining({ type: "plain_text", name: "VALUE", text: "v1" }),
          );

          // Same value → noop; changed value → update.
          const samePlan = yield* stack.plan(program("v1"));
          expect(actionOf(samePlan, "EffectEnvValueWorker")).toBe("noop");
          const changedPlan = yield* stack.plan(program("v2"));
          expect(actionOf(changedPlan, "EffectEnvValueWorker")).toBe("update");

          // The changed value must actually deploy — and then converge.
          const redeployed = yield* stack.deploy(program("v2"));
          const updatedSettings = yield* workers.getScriptScriptAndVersionSetting({
            accountId,
            scriptName: redeployed.workerName,
          });
          expect(updatedSettings.bindings).toContainEqual(
            expect.objectContaining({ type: "plain_text", name: "VALUE", text: "v2" }),
          );
          const resettled = yield* stack.plan(program("v2"));
          expect(actionOf(resettled, "EffectEnvValueWorker")).toBe("noop");

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(deployed.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 360_000 },
    );

    // #1831 regression: a `Config` value read in an Effect-native Worker's
    // Init lands in `props.env` only, which the Worker diff does not compare;
    // the planner compares Init-captured values itself. Changing the value
    // must plan an update and reach the deployed Worker; an unchanged value
    // must stay a noop.
    test.provider(
      "changing a Config value read in Init plans an update",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          // Layer the value over the ambient provider: the harness snapshots
          // `process.env` when the test starts.
          const program = (mode: string) =>
            Effect.gen(function* () {
              const ambient = yield* ConfigProvider.ConfigProvider;
              return yield* InitConfigWorker.pipe(
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.orElse(
                    ConfigProvider.fromUnknown({ INIT_CONFIG_WORKER_MODE: mode }),
                    ambient,
                  ),
                ),
              );
            });

          const actionOf = (plan: any, logicalId: string) =>
            (Object.values(plan.resources) as any[]).find(
              (node: any) => node.resource.LogicalId === logicalId,
            )?.action;

          const deployed = yield* stack.deploy(program("init-config-v1"));
          yield* expectUrlContains(deployed.url!, "init-config-v1", {
            timeout: "60 seconds",
            label: "initial Init config value",
          });

          const samePlan = yield* stack.plan(program("init-config-v1"));
          expect(actionOf(samePlan, "InitConfigWorker")).toBe("noop");
          const changedPlan = yield* stack.plan(program("init-config-v2"));
          expect(actionOf(changedPlan, "InitConfigWorker")).toBe("update");

          const redeployed = yield* stack.deploy(program("init-config-v2"));
          yield* expectUrlContains(redeployed.url!, "init-config-v2", {
            timeout: "60 seconds",
            label: "updated Init config value",
          });
          const resettled = yield* stack.plan(program("init-config-v2"));
          expect(actionOf(resettled, "InitConfigWorker")).toBe("noop");

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(deployed.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 360_000 },
    );

    // `allUrls`/`domains` should reflect the workers.dev URL when the
    // subdomain is enabled and be empty when it isn't. `worker.url` is always
    // `allUrls[0]`, so the three must stay in lockstep across deploys.
    test.provider(
      "allUrls and domains reflect the workers.dev subdomain and track url",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const deploy = (workersDev: boolean) =>
            stack.deploy(
              Effect.gen(function* () {
                return yield* Cloudflare.Worker("DomainsWorker", {
                  main,
                  workersDev,
                  compatibility: { date: "2024-01-01" },
                });
              }),
            );

          const enabled = yield* deploy(true);
          expect(enabled.urls).toHaveLength(1);
          expect(enabled.urls[0]).toMatch(/\.workers\.dev$/);
          expect(enabled.url).toEqual(enabled.urls[0]);
          expect(enabled.domain).toBeUndefined();

          const disabled = yield* deploy(false);
          expect(disabled.urls).toEqual([]);
          expect(disabled.domain).toBeUndefined();
          expect(disabled.url).toBeUndefined();

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(enabled.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"] },
    );

    // Ordering contract: the canonical custom domain leads `urls` (it is the
    // most significant URL), aliases follow in declared order, and the
    // workers.dev URL comes last. Swapping name and alias moves `url`.
    const customDomainZone =
      process.env.CLOUDFLARE_TEST_WORKER_DOMAIN_ZONE_NAME ?? "alchemy-test-2.us";
    test.provider(
      "custom domain outranks workers.dev in urls and selects url",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const suffix = stageSuffix();
          const domainA = `alchemy-worker-a-${suffix}.${customDomainZone}`;
          const domainB = `alchemy-worker-b-${suffix}.${customDomainZone}`;

          yield* stack.destroy();

          const deploy = (workersDev: boolean, domain: { name: string; aliases?: string[] }) =>
            stack.deploy(
              Effect.gen(function* () {
                return yield* Cloudflare.Worker("CustomDomainWorker", {
                  main,
                  workersDev,
                  domain,
                  compatibility: { date: "2024-01-01" },
                });
              }),
            );

          // workers.dev enabled: the canonical domain still leads `urls`,
          // the alias follows, and the workers.dev URL comes last.
          const worker = yield* deploy(true, { name: domainA, aliases: [domainB] });
          expect(worker.urls).toHaveLength(3);
          expect(worker.urls.slice(0, 2)).toEqual([`https://${domainA}`, `https://${domainB}`]);
          expect(worker.urls[2]).toMatch(
            new RegExp(`^https://${worker.workerName}\\..*\\.workers\\.dev$`),
          );
          expect(worker.url).toEqual(`https://${domainA}`);
          expect(worker.domain).toEqual({ name: domainA, aliases: [domainB], redirects: [] });

          // Domain only (no workers.dev): urls is just the domain + alias.
          const domainOnly = yield* deploy(false, { name: domainA, aliases: [domainB] });
          expect(domainOnly.urls).toEqual([`https://${domainA}`, `https://${domainB}`]);
          expect(domainOnly.url).toEqual(`https://${domainA}`);

          // Swap name and alias — `url` follows the canonical name.
          const swapped = yield* deploy(false, { name: domainB, aliases: [domainA] });
          expect(swapped.urls).toEqual([`https://${domainB}`, `https://${domainA}`]);
          expect(swapped.url).toEqual(`https://${domainB}`);
          expect(swapped.domain).toEqual({ name: domainB, aliases: [domainA], redirects: [] });

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"] },
    );

    // State-migration: Worker state written by older Alchemy versions stored
    // `domains` as `https://<hostname>` URL strings with the workers.dev URL
    // mixed in (beta.45–57) or as `{ id, hostname, zoneId }` objects
    // (<= beta.44), and had no `allUrls`. A deploy on top of either shape must
    // not crash the diff/reconcile and must rewrite the attributes to the
    // current shape (bare hostnames aligned with `allUrls`).
    test.provider(
      "redeploy coerces legacy domains state",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const deploy = (date: string) =>
            stack.deploy(
              Effect.gen(function* () {
                return yield* Cloudflare.Worker("LegacyStateWorker", {
                  main,
                  compatibility: { date },
                });
              }),
            );

          const v1 = yield* deploy("2024-01-01");
          const workersDevHost = new URL(v1.url!).hostname;

          // Rewrite the persisted record to a legacy shape. The stale
          // custom-domain entry ("app.example.com") was never attached on
          // Cloudflare, so the redeploy must also converge state back to the
          // observed cloud truth rather than trusting the record. `props`
          // optionally gains the pre-redesign keys so `olds` reaching the diff
          // looks exactly like a record an old deploy persisted.
          const writeLegacyRecord = (legacy: {
            url: string | undefined;
            domains: unknown[];
            legacyProps?: Record<string, unknown>;
          }) =>
            Effect.gen(function* () {
              const state = yield* yield* State;
              const key = { stack: stack.name, stage: stack.stage, fqn: "LegacyStateWorker" };
              const current = yield* state.get(key);
              expect(current).toBeDefined();
              const attr = { ...(current as any).attr, url: legacy.url, domains: legacy.domains };
              delete attr.urls;
              delete attr.domain;
              yield* state.set({
                ...key,
                value: {
                  ...(current as any),
                  attr,
                  props: { ...(current as any).props, ...legacy.legacyProps },
                },
              });
            }).pipe(Effect.provide(stack.state));

          // beta.45–57: URL strings, workers.dev mixed in, no allUrls.
          yield* writeLegacyRecord({
            url: "https://app.example.com",
            domains: ["https://app.example.com", `https://${workersDevHost}`],
          });

          const v2 = yield* deploy("2024-01-02");
          expect(v2.url).toEqual(`https://${workersDevHost}`);
          expect(v2.urls).toEqual([`https://${workersDevHost}`]);
          expect(v2.domain).toBeUndefined();

          // <= beta.44: `{ id, hostname, zoneId }` objects — and the props the
          // old code persisted alongside them (`url`/`subdomain` keys), so the
          // diff's `olds` carries the pre-redesign prop shape too.
          yield* writeLegacyRecord({
            url: undefined,
            domains: [{ id: "legacy", hostname: "app.example.com", zoneId: "z" }],
            legacyProps: { url: true, subdomain: { enabled: true, previewsEnabled: true } },
          });

          const v3 = yield* deploy("2024-01-03");
          expect(v3.url).toEqual(`https://${workersDevHost}`);
          expect(v3.urls).toEqual([`https://${workersDevHost}`]);
          expect(v3.domain).toBeUndefined();

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"] },
    );

    // The real upgrade path for a bare Worker: the user's props are byte-for-
    // byte identical before and after upgrading Alchemy, so the *only* thing
    // that can trigger the state migration is the metadata hash (its surface
    // changed: `url`/`subdomain` keys out, `workersDev` in). The migration
    // must be a one-time update — and a downstream resource consuming
    // `worker.urls` (absent from legacy state) must re-resolve through it
    // and settle back to noop.
    test.provider(
      "props-identical redeploy migrates legacy state via the metadata hash",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          // Never changes across the test — like a user who upgrades Alchemy
          // without touching their stack code.
          const program = Effect.gen(function* () {
            const worker = yield* Cloudflare.Worker("BareUpstream", {
              main,
              compatibility: { date: "2024-01-01" },
            });
            yield* Cloudflare.Alerting.NotificationWebhook("Hook", {
              url: worker.urls.pipe(Output.map((urls) => urls[0]!)),
            });
            return worker;
          });

          const actionOf = (plan: any, logicalId: string) =>
            (Object.values(plan.resources) as any[]).find(
              (node: any) => node.resource.LogicalId === logicalId,
            )?.action;

          const v1 = yield* stack.deploy(program);
          const workersDevHost = new URL(v1.url!).hostname;

          // Rewrite the record to what an old deploy persisted: URL-string
          // domains, no allUrls, and a metadata hash computed over the old
          // surface (any value the new code can't reproduce).
          yield* Effect.gen(function* () {
            const state = yield* yield* State;
            const key = { stack: stack.name, stage: stack.stage, fqn: "BareUpstream" };
            const current = yield* state.get(key);
            expect(current).toBeDefined();
            const attr = {
              ...(current as any).attr,
              url: `https://${workersDevHost}`,
              domains: [`https://${workersDevHost}`],
              hash: { ...(current as any).attr.hash, metadata: "legacy" },
            };
            delete attr.urls;
            yield* state.set({ ...key, value: { ...(current as any), attr } });
          }).pipe(Effect.provide(stack.state));

          // Identical props still plan as an update — driven by the metadata
          // hash alone. The downstream's `allUrls` reference is unresolvable
          // from legacy state (never marked stable), so it takes a one-time
          // update alongside the migration.
          const migrationPlan = yield* stack.plan(program);
          expect(actionOf(migrationPlan, "BareUpstream")).toBe("update");
          expect(actionOf(migrationPlan, "Hook")).toBe("update");

          const migrated = yield* stack.deploy(program);
          expect(migrated.url).toEqual(`https://${workersDevHost}`);
          expect(migrated.urls).toEqual([`https://${workersDevHost}`]);
          expect(migrated.domain).toBeUndefined();

          // Migration is one-time: the same props now settle as a full noop,
          // including the downstream (allUrls is present and stable again).
          const settledPlan = yield* stack.plan(program);
          expect(actionOf(settledPlan, "BareUpstream")).toBe("noop");
          expect(actionOf(settledPlan, "Hook")).toBe("noop");

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(v1.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["provider:cloudflare:alerting", "live"], timeout: 240_000 },
    );

    // Canonical `list()` test (account collection): deploy a real Worker and
    // assert it shows up in the exhaustively-paginated account-wide listing.
    test.provider(
      "list enumerates the deployed worker",
      (stack) =>
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
      { tags: ["live"] },
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
            Object.values(plan.resources).find((node) => node.resource.LogicalId === logicalId)
              ?.action;

          expect(actionOf("Upstream")).toBe("update");
          expect(actionOf("Hook")).toBe("noop");

          yield* stack.destroy();
        }).pipe(logLevel),
      { tags: ["provider:cloudflare:alerting", "live"], timeout: 180_000 },
    );

    precreateRaceTest.provider(
      "deploy survives a settings read that races the precreated durable object",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          precreateRace.hostPath = undefined;
          precreateRace.injected = 0;
          yield* stack.destroy();

          // Only Workers in a dependency cycle are precreated, so the Durable
          // Object host and a second Worker bind each other's URL.
          const { worker, peer } = yield* stack.deploy(
            Effect.gen(function* () {
              const worker = yield* Cloudflare.Worker("PrecreateRaceWorker", {
                script: `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment() {
    const next = ((await this.ctx.storage.get("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", next);
    return next;
  }
}
export default {
  async fetch(request, env) {
    const value = await env.Counter.getByName("shared").increment();
    return new Response("count=" + value);
  },
};`,
                env: { Counter: Cloudflare.DurableObject("Counter") },
              });
              const peer = yield* Cloudflare.Worker("PrecreateRacePeer", { main });
              yield* worker.bind`PEER_URL`({
                bindings: [{ type: "plain_text", name: "PEER_URL", text: peer.url.as<string>() }],
              });
              yield* peer.bind`HOST_URL`({
                bindings: [{ type: "plain_text", name: "HOST_URL", text: worker.url.as<string>() }],
              });
              return { worker, peer };
            }),
          );

          // Both racing reads were injected and the deploy still converged.
          expect(precreateRace.injected).toBe(2);
          expect(Object.keys(worker.durableObjectNamespaces)).toEqual(["Counter"]);
          yield* expectUrlContains(worker.url!, "count=");

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
          yield* waitForWorkerToBeDeleted(peer.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 180_000 },
    );

    test.provider(
      "codeUpdateStrategy defers or applies Durable Object code updates",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const client = yield* HttpClient.HttpClient;
          yield* stack.destroy();

          // The object reports the code version it runs plus an id minted in
          // its constructor, so a reset onto new code is visible.
          const program = (
            version: string,
            codeUpdateStrategy: Cloudflare.WorkerCodeUpdateStrategy,
          ) =>
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("CodeUpdateStrategyWorker", {
                script: `import { DurableObject } from "cloudflare:workers";
export class Probe extends DurableObject {
  started = crypto.randomUUID();
  whoami() {
    return "${version}:" + this.started;
  }
}
export default {
  async fetch(request, env) {
    return new Response(await env.Probe.getByName("shared").whoami());
  },
};`,
                env: { Probe: Cloudflare.DurableObject("Probe") },
                codeUpdateStrategy,
              });
            });
          const deferred = { mode: "deferred", maxDelay: "10 minutes" } as const;
          const immediate = { mode: "immediate" } as const;

          const worker = yield* stack.deploy(program("v1", deferred));
          yield* expectUrlContains(worker.url!, "v1:");
          const whoami = client.get(worker.url!, { headers: { "cache-control": "no-cache" } }).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((response) => response.text),
          );
          const v1 = yield* whoami;
          expect(v1).toMatch(/^v1:/);

          // The strategy applies per deploy: changing only it is not an update.
          const plan = yield* stack.plan(program("v1", immediate));
          expect(
            Object.values(plan.resources).find(
              (node) => node.resource.LogicalId === "CodeUpdateStrategyWorker",
            )?.action,
          ).toBe("noop");

          // Deferred: keep the object active through the deploy, and it
          // keeps running the code it started with.
          const pinger = yield* whoami.pipe(
            Effect.ignore,
            Effect.repeat(Schedule.spaced("1 second")),
            Effect.forkChild,
          );
          yield* stack.deploy(program("v2", deferred));
          const samples = yield* whoami.pipe(
            Effect.repeat({ schedule: Schedule.spaced("1 second"), times: 4 }),
            Effect.andThen(whoami),
          );
          yield* Fiber.interrupt(pinger);
          expect(samples).toBe(v1);

          // Immediate: the object resets onto the new code right away.
          yield* stack.deploy(program("v3", immediate));
          yield* expectUrlContains(worker.url!, "v3:", { timeout: "30 seconds" });

          // Out of range is rejected before anything is uploaded.
          const error = yield* stack
            .deploy(program("v4", { mode: "deferred", maxDelay: "25 hours" }))
            .pipe(Effect.flip);
          expect(error).toMatchObject({ _tag: "WorkerCodeUpdateStrategyError" });

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 240_000 },
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

          yield* stack.deploy(program({ crons: [], dos: ["Counter"], hookRef: "Counter" }));

          // ── Worker-only change, same DO set → hook noop ──
          const workerOnlyPlan = yield* stack.plan(
            program({ crons: ["*/10 * * * *"], dos: ["Counter"], hookRef: "Counter" }),
          );
          expect(actionOf(workerOnlyPlan, "Upstream")).toBe("update");
          expect(actionOf(workerOnlyPlan, "Hook")).toBe("noop");

          // ── Add a DO class (Meter) while hook still refs Counter → Counter's
          // namespace id is unchanged, so the hook is a noop even though the
          // worker must update to register the new class ──
          const addDoPlan = yield* stack.plan(
            program({ crons: ["*/10 * * * *"], dos: ["Counter", "Meter"], hookRef: "Counter" }),
          );
          expect(actionOf(addDoPlan, "Upstream")).toBe("update");
          expect(actionOf(addDoPlan, "Hook")).toBe("noop");

          yield* stack.deploy(
            program({ crons: ["*/10 * * * *"], dos: ["Counter", "Meter"], hookRef: "Counter" }),
          );

          // ── Remove a DO class (Meter) while hook still refs Counter → DO set
          // changed, so the hook must re-plan even though Counter's id is
          // unchanged in the cloud ──
          const removeDoPlan = yield* stack.plan(
            program({ crons: ["*/10 * * * *"], dos: ["Counter"], hookRef: "Counter" }),
          );
          expect(actionOf(removeDoPlan, "Upstream")).toBe("update");
          expect(actionOf(removeDoPlan, "Hook")).toBe("update");

          yield* stack.deploy(
            program({ crons: ["*/10 * * * *"], dos: ["Counter"], hookRef: "Counter" }),
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
            program({ crons: [], dos: ["Meter"], hookRef: "Counter" }),
          );
          expect(actionOf(swapDoPlan, "Upstream")).toBe("update");
          expect(actionOf(swapDoPlan, "Hook")).toBe("noop");

          yield* stack.deploy(program({ crons: [], dos: ["Meter"], hookRef: "Meter" }));

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
      { tags: ["provider:cloudflare:alerting", "live"], timeout: 360_000 },
    );

    test.provider(
      "plain worker importing node builtins deploys without explicit compatibility flags",
      (stack) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          // Regression for #796: a plain (external) `export default { fetch }`
          // Worker importing `node:crypto`, with NO `compatibility` prop. The
          // default `nodejs_compat` must reach both the bundler (so `node:*`
          // stays external instead of warning) and the upload metadata (so
          // Cloudflare doesn't reject with `No such module "node:crypto"`).
          const workerDir = yield* fs.makeTempDirectory({ prefix: "alchemy-worker-node-compat-" });
          const workerPath = path.join(workerDir, "worker.ts");
          yield* fs.writeFileString(
            workerPath,
            `import { randomBytes } from "node:crypto";
export default {
  fetch: async () =>
    new Response("node-compat:" + randomBytes(8).toString("hex")),
};
`,
          );

          const worker = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("NodeCompatDefault", {
                main: workerPath,
                workersDev: true,
              });
            }),
          );

          yield* expectUrlContains(worker.url!, "node-compat:", {
            timeout: "60 seconds",
            label: "node:crypto served under default nodejs_compat",
          });

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 360_000 },
    );

    test.provider(
      "deploys a worker whose main is derived from a Command.Build output",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* stack.destroy();

          // Regression for #1049: `main` computed from another resource's
          // output is still an unresolved Output when `precreate` runs on raw
          // props — `getCompatibility` (via `isPythonMain`) must tolerate it.
          // The entry module only exists after the build command runs, so the
          // Worker cannot know its `main` path until `build.outdir` resolves.
          const marker = testName("alchemy-output-main-e2e-ok-7c31");
          const tempDir = yield* fs.makeTempDirectory({ prefix: "alchemy-output-main-" });
          yield* fs.writeFileString(
            path.join(tempDir, "worker.src.mjs"),
            `export default { fetch: () => new Response(${JSON.stringify(marker)}) };\n`,
          );
          yield* fs.writeFileString(
            path.join(tempDir, "build.sh"),
            "mkdir -p dist\ncp worker.src.mjs dist/worker.mjs\n",
          );

          const worker = yield* stack.deploy(
            Effect.gen(function* () {
              const build = yield* Command.Build("OutputMainBuild", {
                command: "bash build.sh",
                cwd: tempDir,
                outdir: "dist",
              });
              return yield* Cloudflare.Worker("OutputMainWorker", {
                isExternal: true,
                workersDev: true,
                // `build.outdir` is persisted relative to the initial cwd —
                // resolve it against `initialCwd` (per Build's contract), not
                // live `process.cwd()`, which another suite's in-process build
                // can transiently chdir away.
                main: Output.map(build.outdir, (dir) =>
                  pathe.resolve(initialCwd, dir, "worker.mjs"),
                ),
              });
            }),
          );

          expect(worker.url).toBeDefined();
          yield* expectUrlContains(worker.url!, marker);

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["live"], timeout: 360_000 },
    );
  },
);

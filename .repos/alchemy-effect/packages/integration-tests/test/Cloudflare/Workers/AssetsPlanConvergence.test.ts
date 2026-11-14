import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const main = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");
const assetsFixture = pathe.resolve(import.meta.dirname, "fixtures/assets-only");

const actionOf = (plan: any, logicalId: string) =>
  (Object.values(plan.resources) as any[]).find(
    (node: any) => node.resource.LogicalId === logicalId,
  )?.action;

describe.concurrent(
  "Cloudflare.Worker assets plan convergence",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    // A Worker whose `assets` is a plain `{ directory }` (no precomputed
    // `hash` from an upstream build) must still converge to a noop plan when
    // the directory contents are unchanged. The diff hashes the tree the same
    // way the apply does, so users don't have to hand-roll their own
    // directory hashing to get convergent plans.
    test.provider(
      "unchanged assets directory converges to a noop plan",
      (stack) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* stack.destroy();

          // Two independent mutable copies of the assets fixture: `dirA`
          // feeds the main+assets worker, `dirB` feeds the assets-only and
          // script+assets workers, so editing `dirA` must dirty only the
          // first worker.
          const dirA = yield* cloneFixture(assetsFixture, { prefix: "alchemy-assets-plan-a-" });
          const dirB = yield* cloneFixture(assetsFixture, { prefix: "alchemy-assets-plan-b-" });

          // One worker per `hasChanged` branch that previously returned a
          // conservative "changed" whenever `assets` carried no precomputed
          // hash: bundled main + assets, assets-only (no entry), and inline
          // script + assets.
          const program = (a: string, b: string) =>
            Effect.gen(function* () {
              const withMain = yield* Cloudflare.Worker("AssetsPlanWithMain", {
                main,
                assets: { directory: a },
                compatibility: { date: "2024-01-01" },
              });
              const assetsOnly = yield* Cloudflare.Worker("AssetsPlanAssetsOnly", {
                assets: { directory: b, notFoundHandling: "404-page" },
                compatibility: { date: "2024-01-01" },
              });
              const withScript = yield* Cloudflare.Worker("AssetsPlanScript", {
                script: `export default { fetch: () => new Response("assets-plan-script") };`,
                assets: { directory: b },
                compatibility: { date: "2024-01-01" },
              });
              return { withMain, assetsOnly, withScript };
            });

          yield* stack.deploy(program(dirA, dirB));

          // Nothing changed → every worker must plan as a noop. This is the
          // regression: the diff used to refuse to read the assets directory
          // and conservatively reported "update" on every plan.
          const settled = yield* stack.plan(program(dirA, dirB));
          expect(actionOf(settled, "AssetsPlanWithMain")).toBe("noop");
          expect(actionOf(settled, "AssetsPlanAssetsOnly")).toBe("noop");
          expect(actionOf(settled, "AssetsPlanScript")).toBe("noop");

          // Editing an asset in dirA must dirty exactly the worker that
          // serves it — content changes still surface as updates.
          yield* fs.writeFileString(
            path.join(dirA, "index.html"),
            "<html><body>alchemy-assets-plan-index-v2</body></html>",
          );
          const changed = yield* stack.plan(program(dirA, dirB));
          expect(actionOf(changed, "AssetsPlanWithMain")).toBe("update");
          expect(actionOf(changed, "AssetsPlanAssetsOnly")).toBe("noop");
          expect(actionOf(changed, "AssetsPlanScript")).toBe("noop");

          // Deploying the change re-settles the plan.
          yield* stack.deploy(program(dirA, dirB));
          const resettled = yield* stack.plan(program(dirA, dirB));
          expect(actionOf(resettled, "AssetsPlanWithMain")).toBe("noop");
          expect(actionOf(resettled, "AssetsPlanAssetsOnly")).toBe("noop");
          expect(actionOf(resettled, "AssetsPlanScript")).toBe("noop");

          // Path invariance: identical bytes at a different absolute path
          // must hash identically — a plan made from a different checkout
          // (CI runner → laptop, monorepo root → workspace root) converges
          // without spurious updates. The directory path is deliberately
          // excluded from the content hash.
          const dirB2 = yield* cloneFixture(dirB, { prefix: "alchemy-assets-plan-b2-" });
          const moved = yield* stack.plan(program(dirA, dirB2));
          expect(actionOf(moved, "AssetsPlanAssetsOnly")).toBe("noop");
          expect(actionOf(moved, "AssetsPlanScript")).toBe("noop");

          // `.assetsignore` and the files it excludes participate in neither
          // the manifest nor the hash — adding them must stay a noop.
          yield* fs.writeFileString(path.join(dirB, ".assetsignore"), "junk.txt");
          yield* fs.writeFileString(path.join(dirB, "junk.txt"), "not-an-asset");
          const ignored = yield* stack.plan(program(dirA, dirB));
          expect(actionOf(ignored, "AssetsPlanAssetsOnly")).toBe("noop");
          expect(actionOf(ignored, "AssetsPlanScript")).toBe("noop");

          // `_headers` is excluded from the manifest but shipped via the
          // asset config, so editing it must dirty every worker serving the
          // directory.
          yield* fs.writeFileString(path.join(dirB, "_headers"), "/*\n  X-Assets-Plan: v1\n");
          const headers = yield* stack.plan(program(dirA, dirB));
          expect(actionOf(headers, "AssetsPlanWithMain")).toBe("noop");
          expect(actionOf(headers, "AssetsPlanAssetsOnly")).toBe("update");
          expect(actionOf(headers, "AssetsPlanScript")).toBe("update");
          yield* fs.remove(path.join(dirB, "_headers"));
          const headersReverted = yield* stack.plan(program(dirA, dirB));
          expect(actionOf(headersReverted, "AssetsPlanAssetsOnly")).toBe("noop");
          expect(actionOf(headersReverted, "AssetsPlanScript")).toBe("noop");

          // A directory that's missing at plan time (e.g. produced by an
          // upstream build step that only runs during apply) degrades to
          // "update" — the plan must not crash.
          yield* fs.remove(dirA, { recursive: true });
          const missing = yield* stack.plan(program(dirA, dirB));
          expect(actionOf(missing, "AssetsPlanWithMain")).toBe("update");
          expect(actionOf(missing, "AssetsPlanAssetsOnly")).toBe("noop");
          expect(actionOf(missing, "AssetsPlanScript")).toBe("noop");

          yield* stack.destroy();
        }),
      { timeout: 360_000 },
    );

    // The migration path off a hand-rolled hash: a worker deployed with a
    // user-supplied `assets.hash` whose props then drop the hash must plan
    // exactly one update (the stored custom hash can't match the content
    // hash), converge after the deploy, and dirty again if a different
    // supplied hash is introduced.
    test.provider(
      "removing a supplied assets hash converges after one deploy",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const dir = yield* cloneFixture(assetsFixture, {
            prefix: "alchemy-assets-hash-migration-",
          });

          const program = (hash?: string) =>
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("AssetsHashMigration", {
                main,
                assets: hash ? { directory: dir, hash } : { directory: dir },
                compatibility: { date: "2024-01-01" },
              });
            });

          // Deployed with a hand-rolled hash: the supplied hash is
          // authoritative, so an identical plan is a noop without reading
          // the directory.
          yield* stack.deploy(program("hand-rolled-hash-v1"));
          const settled = yield* stack.plan(program("hand-rolled-hash-v1"));
          expect(actionOf(settled, "AssetsHashMigration")).toBe("noop");

          // Dropping the hash falls back to content hashing — the stored
          // custom hash can't match, so exactly one update is planned...
          const dropped = yield* stack.plan(program());
          expect(actionOf(dropped, "AssetsHashMigration")).toBe("update");

          // ...and after deploying, the stored hash is the content hash and
          // the plan converges.
          yield* stack.deploy(program());
          const converged = yield* stack.plan(program());
          expect(actionOf(converged, "AssetsHashMigration")).toBe("noop");

          // Re-introducing a different supplied hash dirties the plan again.
          const reintroduced = yield* stack.plan(program("hand-rolled-hash-v2"));
          expect(actionOf(reintroduced, "AssetsHashMigration")).toBe("update");

          yield* stack.destroy();
        }),
      { timeout: 360_000 },
    );

    // `.assetsignore` excludes a folder the deploying user cannot read (e.g.
    // a root-owned cache). Its files must not be uploaded, and the walk must
    // not read it at all — reading it used to fail the deploy with EACCES.
    test.provider(
      "excludes .assetsignore'd folders without reading them",
      (stack) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const client = yield* HttpClient.HttpClient;

          yield* stack.destroy();

          const dir = yield* cloneFixture(assetsFixture, { prefix: "alchemy-assets-ignore-" });
          yield* fs.writeFileString(path.join(dir, ".assetsignore"), "private/\n*.map\n");
          yield* fs.writeFileString(path.join(dir, "app.js.map"), "{}");
          const locked = path.join(dir, "private", "cache");
          yield* fs.makeDirectory(locked, { recursive: true });
          yield* fs.writeFileString(path.join(dir, "private", "secret.txt"), "secret");
          yield* Effect.acquireRelease(fs.chmod(locked, 0o000), () =>
            fs.chmod(locked, 0o755).pipe(Effect.ignore),
          );

          const worker = yield* stack.deploy(
            Cloudflare.Worker("AssetsIgnoreWorker", {
              assets: { directory: dir, notFoundHandling: "404-page" },
              compatibility: { date: "2024-01-01" },
            }),
          );

          const status = (pathname: string) =>
            client.get(new URL(pathname, worker.url).href).pipe(
              Effect.map((response) => response.status),
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (code) => code !== 503 && code !== 522,
                times: 30,
              }),
            );
          // The served index proves the Worker is live before asserting 404s.
          expect(
            yield* status("/index.html").pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (code) => code === 200,
                times: 30,
              }),
            ),
          ).toBe(200);
          expect(yield* status("/private/secret.txt")).toBe(404);
          expect(yield* status("/app.js.map")).toBe(404);

          yield* stack.destroy();
        }),
      { timeout: 180_000 },
    );
  },
);

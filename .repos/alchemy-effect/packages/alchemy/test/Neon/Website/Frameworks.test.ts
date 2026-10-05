import { providers } from "@/Neon/Providers.ts";
import * as Test from "@/Test/Alchemy.ts";
import { getProject, getProjectBranchFunction } from "@distilled.cloud/neon";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import {
  bodyContaining,
  exampleRoot,
  updatedBodyContaining,
} from "./Fixture.ts";
import { functionRolloutTimeout } from "../FunctionRollout.ts";
import { frameworks } from "./Frameworks.ts";
import { browserRoundtrip } from "./Browser.ts";

const { test } = Test.make({ providers: providers() });
const deployments = Semaphore.makeUnsafe(1);

describe.concurrent(
  "Neon Website complete lifecycle",
  { tags: ["provider:neon", "provider:neon:website", "live"] },
  () => {
    for (const { slug, name, website } of frameworks) {
      // Each live lifecycle deploys, polls rollout, and browser-verifies
      // (~3 minutes); skip the whole matrix under --fast.
      test.provider.skipIf(!!process.env.FAST)(
        slug,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const rootDir = yield* exampleRoot(slug);
            const asset = path.join(
              rootDir,
              slug === "sveltekit" ? "static" : "public",
              "example.json",
            );
            const original = yield* fs.readFileString(asset);
            yield* Effect.addFinalizer(() =>
              fs.writeFileString(asset, original).pipe(Effect.orDie),
            );
            const deploy = stack
              .deploy(
                Effect.gen(function* () {
                  return yield* website("Web", {
                    rootDir,
                    env: { GREETING: `Hello from ${name} on Neon!` },
                  });
                }),
              )
              .pipe(deployments.withPermit);
            const site = yield* deploy;
            expect(site.url).toMatch(/^https:\/\//);
            const url = String(site.url).replace(/\/+$/, "");
            const fn = site.function!;
            yield* Effect.logInfo(
              `Website ${slug}: deployed project=${fn.projectId} function=${fn.functionId} deployment=${fn.activeDeploymentId} url=${site.url}`,
            );
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* stack.destroy();
                expect(
                  yield* getProject({ project_id: fn.projectId }).pipe(
                    Effect.as(false),
                    Effect.catchTag("NotFound", () => Effect.succeed(true)),
                  ),
                ).toBe(true);
                yield* Effect.logInfo(`Website ${slug}: cleanup verified`);
              }).pipe(Effect.orDie),
            );
            yield* bodyContaining(`${url}/`, name);
            yield* browserRoundtrip(url, slug).pipe(Effect.scoped);
            const head = yield* HttpClient.head(`${url}/example.json`);
            expect(head.status).toBe(200);
            expect(yield* head.text).toBe("");
            const found = yield* getProjectBranchFunction({
              project_id: fn.projectId,
              branch_id: fn.branchId,
              slug: fn.slug,
            });
            expect(found.function.active_deployment?.id).toBe(
              fn.activeDeploymentId,
            );
            const unchanged = yield* deploy;
            expect(unchanged.function!.activeDeploymentId).toBe(
              fn.activeDeploymentId,
            );
            yield* Effect.logInfo(`Website ${slug}: initial no-op verified`);
            yield* fs.writeFileString(
              asset,
              '{"framework":"Neon Website lifecycle updated"}',
            );
            const updated = yield* deploy;
            expect(updated.function!.functionId).toBe(fn.functionId);
            expect(updated.url).toBe(site.url);
            expect(updated.function!.activeDeploymentId).not.toBe(
              fn.activeDeploymentId,
            );
            yield* Effect.logInfo(
              `Website ${slug}: update accepted deployment=${updated.function!.activeDeploymentId}`,
            );
            yield* updatedBodyContaining(
              `${String(updated.url).replace(/\/+$/, "")}/example.json`,
              "Neon Website lifecycle updated",
            );
            yield* Effect.logInfo(`Website ${slug}: updated content verified`);
            const settled = yield* deploy;
            expect(settled.function!.activeDeploymentId).toBe(
              updated.function!.activeDeploymentId,
            );
            yield* stack.destroy();
            expect(
              yield* getProject({ project_id: fn.projectId }).pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
            ).toBe(true);
          }).pipe(Effect.scoped),
        { timeout: functionRolloutTimeout },
      );
    }
  },
);

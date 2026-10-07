import { providers } from "@/Neon/Providers.ts";
import { WebsiteArtifact } from "@/Neon/Website/Artifact.ts";
import { deployWebsite } from "@/Neon/Website/FrameworkSite.ts";
import { Astro } from "@/Neon/Website/Astro.ts";
import { Nextjs } from "@/Neon/Website/Nextjs.ts";
import * as Test from "@/Test/Alchemy.ts";
import { getProject, getProjectBranchFunction } from "@distilled.cloud/neon";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import { functionRolloutTimeout } from "../FunctionRollout.ts";
import { exampleRoot, updatedBodyContaining } from "./Fixture.ts";

const { test } = Test.make({ providers: providers() });

describe.sequential(
  "Neon Website feasibility",
  { tags: ["provider:neon", "provider:neon:website", "live"] },
  () => {
    // Live deploy + rollout polling takes minutes; skip under --fast.
    test.provider.skipIf(!!process.env.FAST)(
      "static Fetch files deploy, update, no-op, HEAD, and destroy",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "neon-static-feasibility-",
          });
          const distDir = path.join(root, "dist");
          yield* fs.makeDirectory(distDir);
          yield* fs.writeFileString(
            path.join(distDir, "index.html"),
            "<h1>Neon static feasibility</h1>",
          );
          yield* fs.writeFileString(
            path.join(distDir, "asset.json"),
            '{"ok":true}',
          );
          const deploy = stack.deploy(
            Effect.gen(function* () {
              const artifact = yield* WebsiteArtifact("Artifact", {
                root,
                distDir,
                static: { notFoundHandling: "spa" },
              });
              return yield* deployWebsite({}, artifact);
            }),
          );
          const site = yield* deploy;
          expect(site.function).toBeDefined();
          const fn = site.function!;
          expect(
            yield* HttpClient.get(`${site.url}/deep/link`).pipe(
              Effect.flatMap((res) => res.text),
            ),
          ).toContain("Neon static feasibility");
          const head = yield* HttpClient.head(`${site.url}/asset.json`);
          expect(head.status).toBe(200);
          expect(yield* head.text).toBe("");
          const observed = yield* getProjectBranchFunction({
            project_id: fn.projectId,
            branch_id: fn.branchId,
            slug: fn.slug,
          });
          expect(observed).toBeDefined();
          const unchanged = yield* deploy;
          expect(unchanged.function!.activeDeploymentId).toBe(
            fn.activeDeploymentId,
          );
          yield* fs.writeFileString(
            path.join(distDir, "index.html"),
            "<h1>Neon static updated</h1>",
          );
          const updated = yield* deploy;
          expect(updated.function!.functionId).toBe(fn.functionId);
          expect(updated.function!.activeDeploymentId).not.toBe(
            fn.activeDeploymentId,
          );
          expect(updated.url).toBe(site.url);
          yield* updatedBodyContaining(
            String(updated.url),
            "Neon static updated",
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

    for (const [slug, website] of [
      ["astro", Astro],
      ["nextjs", Nextjs],
    ] as const) {
      test.provider.skipIf(!!process.env.FAST)(
        `${slug} real framework deploy feasibility`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* exampleRoot(slug);
            const site = yield* stack.deploy(
              website("Web", {
                rootDir,
                memo: slug === "nextjs" ? false : undefined,
                env: {
                  GREETING: `Hello from ${slug === "astro" ? "Astro" : "Next.js"} on Neon!`,
                },
              }),
            );
            const response = yield* HttpClient.get(String(site.url));
            expect(response.status).toBe(200);
            expect(yield* response.text).toContain("Neon");
            expect(
              (yield* HttpClient.get(`${site.url}/example.json`)).status,
            ).toBe(200);
            expect(
              (yield* HttpClient.get(`${site.url}/api/hello?name=Alchemy`))
                .status,
            ).toBe(200);
            const fn = site.function!;
            yield* getProjectBranchFunction({
              project_id: fn.projectId,
              branch_id: fn.branchId,
              slug: fn.slug,
            });
            yield* stack.destroy();
            expect(
              yield* getProject({ project_id: fn.projectId }).pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
            ).toBe(true);
          }),
        { timeout: 120_000 },
      );
    }
  },
);

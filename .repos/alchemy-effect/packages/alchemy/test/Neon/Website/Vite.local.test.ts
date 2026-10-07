import * as Alchemy from "@/index.ts";
import { providers } from "@/Neon/Providers.ts";
import { Vite } from "@/Neon/Website/Vite.ts";
import * as Test from "@/Test/Alchemy.ts";
import { getProject, getProjectBranchFunction } from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import { bodyContaining, exampleRoot } from "./Fixture.ts";

const { test } = Test.make({ providers: providers(), dev: true });

test.provider(
  "Vite hot reloads files and restarts for environment changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* exampleRoot("vite");
      const asset = path.join(rootDir, "public", "example.json");
      const original = yield* fs.readFileString(asset);
      yield* Effect.addFinalizer(() =>
        fs.writeFileString(asset, original).pipe(Effect.orDie),
      );
      const deploy = (value: string) =>
        stack.deploy(Vite("Web", { rootDir, env: { VITE_REVISION: value } }));
      const site = yield* deploy("first");
      yield* bodyContaining(`${site.url}/src/App.tsx`, "Vite");
      yield* fs.writeFileString(asset, '{"framework":"hot-reloaded"}');
      yield* bodyContaining(`${site.url}/example.json`, "hot-reloaded");
      const restarted = yield* deploy("second");
      expect(restarted.function).toBeUndefined();
      yield* bodyContaining(`${restarted.url}/src/App.tsx`, "second");
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: ["provider:neon", "provider:neon:website", "local"],
    timeout: 120_000,
    exclusive: true,
  },
);

test.provider(
  "remote opts into a real Function and destroys its stamped live resources",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const rootDir = yield* exampleRoot("vite");
      const site = yield* stack.deploy(
        Vite("Web", {
          rootDir,
          env: {
            VITE_REVISION: "public-build-marker",
            SERVER_ONLY_MARKER: Redacted.make("private-runtime-marker"),
          },
        }).pipe(Alchemy.remote()),
      );
      expect(site.url).toMatch(/^https:\/\//);
      const fn = site.function!;
      expect(fn.functionId.startsWith("dev:")).toBe(false);
      const observed = yield* getProjectBranchFunction({
        project_id: fn.projectId,
        branch_id: fn.branchId,
        slug: fn.slug,
      });
      expect(observed.function.id).toBe(fn.functionId);
      const html = yield* bodyContaining(
        `${site.url}/deep/link`,
        "Vite on Neon",
      );
      const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(
        (match) => match[1]!,
      );
      expect(scripts.length).toBeGreaterThan(0);
      let javascript = "";
      for (const script of scripts) {
        javascript += yield* HttpClient.get(
          new URL(script, String(site.url)).href,
        ).pipe(Effect.flatMap((response) => response.text));
      }
      expect(javascript).toContain("public-build-marker");
      expect(html + javascript).not.toContain("private-runtime-marker");
      yield* stack.destroy();
      expect(
        yield* getProject({ project_id: fn.projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  {
    tags: ["provider:neon", "provider:neon:website", "live"],
    timeout: 120_000,
    exclusive: true,
  },
);

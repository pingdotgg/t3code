import { providers } from "@/Neon/Providers.ts";
import { WebsiteArtifact } from "@/Neon/Website/Artifact.ts";
import { deployWebsite } from "@/Neon/Website/FrameworkSite.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { exampleRoot } from "./Fixture.ts";

const { test } = Test.make({ providers: providers() });

test.provider(
  "website fixtures isolate sources, build output and dependency caches",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const roots = yield* Effect.gen(function* () {
        const first = yield* exampleRoot("vite");
        const second = yield* exampleRoot("vite");
        expect(first).not.toBe(second);
        expect(path.basename(path.dirname(first))).toBe("examples");
        const asset = "public/example.json";
        const original = yield* fs.readFileString(path.join(second, asset));
        yield* fs.writeFileString(path.join(first, asset), "changed");
        expect(yield* fs.readFileString(path.join(second, asset))).toBe(
          original,
        );
        yield* fs.makeDirectory(path.join(first, "node_modules/.vite"));
        yield* fs.writeFileString(
          path.join(first, "node_modules/.vite/marker"),
          "private",
        );
        expect(
          yield* fs.exists(path.join(second, "node_modules/.vite/marker")),
        ).toBe(false);
        expect(
          yield* fs.exists(path.resolve(first, "../../tsconfig.base.json")),
        ).toBe(true);
        expect(yield* fs.realPath(path.join(first, "node_modules/vite"))).toBe(
          yield* fs.realPath(path.join(second, "node_modules/vite")),
        );
        expect(yield* fs.exists(path.join(first, "dist"))).toBe(false);
        return [first, second];
      }).pipe(Effect.scoped);
      for (const root of roots) expect(yield* fs.exists(root)).toBe(false);
      yield* stack.destroy();
    }),
  { tags: ["provider:neon", "provider:neon:website", "live"] },
);

test.provider(
  "owned backend provisioning depends on artifact validation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const plan = yield* stack.plan(
        Effect.gen(function* () {
          const artifact = yield* WebsiteArtifact("Artifact", {
            root: ".",
            distDir: "dist",
            static: {},
          });
          return yield* deployWebsite({}, artifact);
        }),
      );
      expect(plan.resources.Artifact?.downstream).toContain("Project");
      expect(plan.resources.Project?.action).toBe("create");
      expect(plan.resources.Function?.action).toBe("create");
      yield* stack.destroy();
    }),
  {
    tags: ["provider:neon", "provider:neon:website", "live"],
    timeout: 120_000,
  },
);

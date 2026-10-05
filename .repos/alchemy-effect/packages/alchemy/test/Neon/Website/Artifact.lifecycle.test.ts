import {
  WebsiteArtifact,
  WebsiteArtifactProvider,
} from "@/Neon/Website/Artifact.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { unzipSync } from "fflate";

const { test } = Test.make({ providers: WebsiteArtifactProvider() });

test.provider(
  "artifact lifecycle tracks files, preserves no-op hashes, repairs missing and corrupt ZIPs, and deletes staging",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "neon-artifact-lifecycle-",
      });
      const distDir = path.join(root, "dist");
      yield* fs.makeDirectory(distDir);
      yield* fs.writeFileString(
        path.join(distDir, "index.html"),
        "first artifact",
      );
      const deploy = stack.deploy(
        WebsiteArtifact("Artifact", { root, distDir, static: {} }),
      );
      const first = yield* deploy;
      expect((yield* deploy).hash).toBe(first.hash);
      yield* fs.writeFileString(
        path.join(distDir, "index.html"),
        "updated artifact",
      );
      const updated = yield* deploy;
      expect(updated.hash).not.toBe(first.hash);
      expect(updated.artifactPath).not.toBe(first.artifactPath);
      const archive = yield* fs.readFile(updated.artifactPath);
      const files = yield* Effect.sync(() => unzipSync(archive));
      const html = Object.entries(files).find(([name]) =>
        name.endsWith("/index.html"),
      )![1];
      expect(yield* Effect.sync(() => new TextDecoder().decode(html))).toBe(
        "updated artifact",
      );
      yield* fs.writeFileString(updated.artifactPath, "corrupt");
      expect((yield* deploy).hash).toBe(updated.hash);
      expect(yield* fs.readFile(updated.artifactPath)).toEqual(archive);
      yield* fs.remove(updated.artifactPath);
      expect((yield* deploy).hash).toBe(updated.hash);
      expect(yield* fs.exists(updated.artifactPath)).toBe(true);
      yield* stack.destroy();
      expect(yield* fs.exists(updated.directory)).toBe(false);
    }).pipe(Effect.scoped),
  {
    tags: ["unit", "provider:neon", "provider:neon:website", "local"],
    timeout: 120_000,
  },
);

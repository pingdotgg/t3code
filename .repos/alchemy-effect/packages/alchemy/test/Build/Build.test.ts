import * as AWS from "@/AWS";
import * as Build from "@/Build";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as pathe from "pathe";

const { test } = Test.make({ providers: AWS.providers() });

const fixtureDir = pathe.resolve(import.meta.dirname, "fixture");

test.provider(
  "create, skip, update, delete build",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* stack.destroy();

      const distDir = pathe.join(fixtureDir, "dist");
      yield* fs
        .remove(distDir, { recursive: true })
        .pipe(Effect.catch(() => Effect.void));

      const build1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Build.Command("test-build", {
            command: "bash build.sh",
            cwd: fixtureDir,
            outdir: "dist",
          });
        }),
      );

      expect(build1.outdir).toBe(distDir);
      expect(build1.hash).toBeDefined();
      expect(typeof build1.hash).toBe("string");
      expect(build1.hash.length).toBeGreaterThan(0);

      const distExists = yield* fs.exists(distDir);
      expect(distExists).toBe(true);

      const outputExists = yield* fs.exists(pathe.join(distDir, "output.txt"));
      expect(outputExists).toBe(true);

      const firstBuildOutput = yield* fs.readFileString(
        pathe.join(distDir, "output.txt"),
      );

      yield* Effect.sleep(1100);

      const build2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Build.Command("test-build", {
            command: "bash build.sh",
            cwd: fixtureDir,
            outdir: "dist",
          });
        }),
      );

      expect(build2.hash).toBe(build1.hash);

      const secondBuildOutput = yield* fs.readFileString(
        pathe.join(distDir, "output.txt"),
      );
      expect(secondBuildOutput).toBe(firstBuildOutput);

      yield* fs.writeFileString(
        pathe.join(fixtureDir, "src", "main.ts"),
        'export const message = "Updated!";\n',
      );

      const build3 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Build.Command("test-build", {
            command: "bash build.sh",
            cwd: fixtureDir,
            outdir: "dist",
          });
        }),
      );

      expect(build3.hash).not.toBe(build1.hash);

      const thirdBuildOutput = yield* fs.readFileString(
        pathe.join(distDir, "output.txt"),
      );
      expect(thirdBuildOutput).not.toBe(firstBuildOutput);

      yield* fs.writeFileString(
        pathe.join(fixtureDir, "src", "main.ts"),
        'export const message = "Hello, World!";\n',
      );

      yield* stack.destroy();

      const distExistsAfterDestroy = yield* fs.exists(distDir);
      expect(distExistsAfterDestroy).toBe(false);
    }),
  { timeout: 60000 },
);

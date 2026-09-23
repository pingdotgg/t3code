import * as Command from "@/Command";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as pathe from "pathe";

const { test } = Test.make({ providers: Command.providers() });

const FIXTURE_DIR = pathe.resolve(import.meta.dirname, "fixture");

const makeTemporaryFixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const tempDir = yield* fs.makeTempDirectoryScoped();
  yield* fs.copy(FIXTURE_DIR, tempDir);
  return {
    cwd: tempDir,
    outdir: pathe.join(tempDir, "dist"),
  };
});

test.provider(
  "create, skip, update, delete build with memoization",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      yield* stack.destroy();

      const fixture = yield* makeTemporaryFixture();

      const deploy = () =>
        stack.deploy(
          Command.Build("test-build", {
            command: "bash build.sh",
            cwd: fixture.cwd,
            outdir: "dist",
          }),
        );

      const build1 = yield* deploy();

      // `outdir` is persisted relative to `process.cwd()` for portability;
      // resolve it back to an absolute path before comparing.
      expect(pathe.resolve(build1.outdir)).toBe(fixture.outdir);
      expect(build1.hash).toMatchObject({
        input: expect.any(String),
        output: expect.any(String),
      });

      const distExists = yield* fs.exists(fixture.outdir);
      expect(distExists).toBe(true);

      const outputExists = yield* fs.exists(
        pathe.join(fixture.outdir, "output.txt"),
      );
      expect(outputExists).toBe(true);

      const firstBuildOutput = yield* fs.readFileString(
        pathe.join(fixture.outdir, "output.txt"),
      );

      yield* Effect.sleep(1100);

      const build2 = yield* deploy();

      expect(build2.hash).toMatchObject(build1.hash);

      const secondBuildOutput = yield* fs.readFileString(
        pathe.join(fixture.outdir, "output.txt"),
      );
      expect(secondBuildOutput).toBe(firstBuildOutput);

      yield* fs.writeFileString(
        pathe.join(fixture.cwd, "src", "main.ts"),
        'export const message = "Updated!";\n',
      );

      const build3 = yield* deploy();

      expect(build3.hash).not.toMatchObject(build1.hash);

      const thirdBuildOutput = yield* fs.readFileString(
        pathe.join(fixture.outdir, "output.txt"),
      );
      expect(thirdBuildOutput).not.toBe(firstBuildOutput);

      yield* fs.writeFileString(
        pathe.join(fixture.cwd, "src", "main.ts"),
        'export const message = "Hello, World!";\n',
      );

      yield* stack.destroy();

      const distExistsAfterDestroy = yield* fs.exists(fixture.outdir);
      expect(distExistsAfterDestroy).toBe(false);
    }),
  { timeout: 60000 },
);

test.provider(
  "input hash folds in the build command and env",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fixture = yield* makeTemporaryFixture();

      const deploy = (props: Partial<Command.BuildProps>) =>
        stack.deploy(
          Command.Build("test-build", {
            command: "bash build.sh",
            cwd: fixture.cwd,
            outdir: "dist",
            ...props,
          }),
        );

      const withEnvA = yield* deploy({ env: { API_URL: "https://a.example" } });

      // Same source tree + outdir, only the env differs: the build must not be
      // judged reusable, so the input hash must change.
      const withEnvB = yield* deploy({ env: { API_URL: "https://b.example" } });
      expect(withEnvB.hash.input).not.toBe(withEnvA.hash.input);

      // Likewise a change to the command string busts the input hash.
      const withCommand = yield* deploy({
        command: "bash build.sh dummy",
        env: { API_URL: "https://b.example" },
      });
      expect(withCommand.hash.input).not.toBe(withEnvB.hash.input);

      yield* stack.destroy();
    }),
  { timeout: 60000 },
);

test.provider("rebuilds memoized output if outdir is missing", (stack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    yield* stack.destroy();

    const fixture = yield* makeTemporaryFixture();
    expect(yield* fs.exists(fixture.outdir)).toBe(false);

    const deploy = () =>
      stack.deploy(
        Command.Build("test-build", {
          command: "bash build.sh",
          cwd: fixture.cwd,
          outdir: "dist",
        }),
      );

    yield* deploy();
    expect(yield* fs.exists(fixture.outdir)).toBe(true);

    yield* fs.remove(fixture.outdir, { recursive: true });
    expect(yield* fs.exists(fixture.outdir)).toBe(false);

    yield* deploy();
    expect(yield* fs.exists(fixture.outdir)).toBe(true);

    yield* stack.destroy();
  }),
);

test.provider(
  "memo include globs can reach outside cwd (monorepo workspace deps)",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      yield* stack.destroy();

      // A monorepo shape: the app builds from `app/` and imports a sibling
      // workspace package at `packages/env/` that the default memo scope
      // (files under `cwd`) does not cover.
      const tempDir = yield* fs.makeTempDirectoryScoped();
      const appDir = pathe.join(tempDir, "app");
      const siblingDir = pathe.join(tempDir, "packages", "env");
      yield* fs.copy(FIXTURE_DIR, appDir);
      yield* fs.makeDirectory(siblingDir, { recursive: true });
      const siblingFile = pathe.join(siblingDir, "value.ts");
      yield* fs.writeFileString(siblingFile, 'export const value = "a";\n');

      const outputFile = pathe.join(appDir, "dist", "output.txt");
      // Exclude `dist` from the memo hash: build.sh stamps `dist/output.txt`
      // with $(date) (the test's rebuild detector), and the temp fixture has
      // no .gitignore to filter it. With dist hashed, two rebuilds straddling
      // a wall-clock second boundary would produce different "input" hashes.
      const deploy = () =>
        stack.deploy(
          Command.Build("test-build", {
            command: "bash build.sh",
            cwd: appDir,
            outdir: "dist",
            memo: {
              include: ["**/*", "../packages/env/**"],
              exclude: ["dist/**"],
            },
          }),
        );

      const build1 = yield* deploy();
      const firstOutput = yield* fs.readFileString(outputFile);

      // Nothing changed (including the sibling): the build memoizes.
      yield* Effect.sleep(1100);
      const build2 = yield* deploy();
      expect(build2.hash).toMatchObject(build1.hash);
      expect(yield* fs.readFileString(outputFile)).toBe(firstOutput);

      // Editing only the sibling package busts the input hash and rebuilds.
      yield* fs.writeFileString(siblingFile, 'export const value = "b";\n');
      const build3 = yield* deploy();
      expect(build3.hash.input).not.toBe(build1.hash.input);
      expect(yield* fs.readFileString(outputFile)).not.toBe(firstOutput);

      // An *absolute* include glob matches the same files: its matches are
      // normalized back to cwd-relative keys, so the input hash is identical
      // to the `../` form — machine-specific path prefixes never leak into
      // the hash (and the build memoizes instead of rerunning).
      const build4 = yield* stack.deploy(
        Command.Build("test-build", {
          command: "bash build.sh",
          cwd: appDir,
          outdir: "dist",
          memo: {
            include: ["**/*", pathe.join(siblingDir, "**")],
            exclude: ["dist/**"],
          },
        }),
      );
      expect(build4.hash.input).toBe(build3.hash.input);

      yield* stack.destroy();
    }),
  { timeout: 60000 },
);

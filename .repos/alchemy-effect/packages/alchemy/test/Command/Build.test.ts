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

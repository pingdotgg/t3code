import { assert, it } from "@effect/vitest";
import { DateTime, Option } from "effect";
import { Effect, FileSystem, Layer, Path, type PlatformError, type Scope } from "effect";
import { describe } from "vitest";

import type { VcsDriverKind } from "@t3tools/contracts";
import { VcsDriver } from "../VcsDriver.ts";

export interface VcsDriverFixture<R, E> {
  readonly createRepo: (cwd: string) => Effect.Effect<void, E, R>;
  readonly writeFile: (
    cwd: string,
    relativePath: string,
    contents: string,
  ) => Effect.Effect<void, E, R | FileSystem.FileSystem | Path.Path>;
  readonly trackFile?: (cwd: string, relativePath: string) => Effect.Effect<void, E, R>;
  readonly commit?: (cwd: string, message: string) => Effect.Effect<void, E, R>;
  readonly ignorePath: (
    cwd: string,
    pattern: string,
  ) => Effect.Effect<void, E, R | FileSystem.FileSystem | Path.Path>;
}

export interface VcsDriverContractSuiteInput<R, E> {
  readonly name: string;
  readonly kind: VcsDriverKind;
  readonly layer: Layer.Layer<VcsDriver | R | FileSystem.FileSystem | Path.Path, E, never>;
  readonly fixture: VcsDriverFixture<R, E>;
}

export function runVcsDriverContractSuite<R, E>(input: VcsDriverContractSuiteInput<R, E>) {
  const makeTmpDir = (
    prefix = `t3-${input.kind}-vcs-contract-`,
  ): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* fileSystem.makeTempDirectoryScoped({ prefix });
    });

  it.layer(input.layer)(`${input.name} VCS driver contract`, (it) => {
    describe("repository detection", () => {
      it.effect("returns null outside a repository", () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const driver = yield* VcsDriver;

          assert.equal(yield* driver.detectRepository(cwd), null);
          assert.equal(yield* driver.isInsideWorkTree(cwd), false);
        }),
      );

      it.effect("detects repository identity inside a repository and nested directories", () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const driver = yield* VcsDriver;

          yield* input.fixture.createRepo(cwd);
          yield* input.fixture.writeFile(cwd, "src/index.ts", "export const value = 1;\n");
          const fileSystem = yield* FileSystem.FileSystem;
          const realCwd = yield* fileSystem.realPath(cwd);
          const identity = yield* driver.detectRepository(cwd);
          assert.equal(identity?.kind, input.kind);
          assert.isTrue(identity?.rootPath.endsWith(realCwd));
          assert.equal(identity?.freshness.source, "live-local");
          assert.isTrue(DateTime.isDateTime(identity?.freshness.observedAt));
          assert.isTrue(Option.isNone(identity?.freshness.expiresAt ?? Option.none()));
          assert.equal(yield* driver.isInsideWorkTree(cwd), true);

          const path = yield* Path.Path;
          const nestedDir = path.join(cwd, "src");
          const nestedIdentity = yield* driver.detectRepository(nestedDir);
          assert.equal(nestedIdentity?.rootPath, identity?.rootPath);
          assert.equal(yield* driver.isInsideWorkTree(nestedDir), true);
        }),
      );
    });

    describe("workspace files", () => {
      it.effect("lists tracked and untracked non-ignored files", () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const driver = yield* VcsDriver;

          yield* input.fixture.createRepo(cwd);
          yield* input.fixture.writeFile(cwd, "tracked.ts", "export const tracked = true;\n");
          if (input.fixture.trackFile && input.fixture.commit) {
            yield* input.fixture.trackFile(cwd, "tracked.ts");
            yield* input.fixture.commit(cwd, "Track file");
          }
          yield* input.fixture.writeFile(cwd, "untracked.ts", "export const untracked = true;\n");

          const result = yield* driver.listWorkspaceFiles(cwd);

          assert.include(result.paths, "tracked.ts");
          assert.include(result.paths, "untracked.ts");
          assert.equal(result.truncated, false);
          assert.equal(result.freshness.source, "live-local");
          assert.isTrue(DateTime.isDateTime(result.freshness.observedAt));
          assert.isTrue(Option.isNone(result.freshness.expiresAt));
        }),
      );

      it.effect("excludes ignored files from workspace listing", () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const driver = yield* VcsDriver;

          yield* input.fixture.createRepo(cwd);
          yield* input.fixture.ignorePath(cwd, "*.log");
          yield* input.fixture.writeFile(cwd, "included.ts", "export const included = true;\n");
          yield* input.fixture.writeFile(cwd, "debug.log", "ignore me\n");
          yield* input.fixture.writeFile(cwd, "nested/error.log", "ignore me too\n");

          const result = yield* driver.listWorkspaceFiles(cwd);

          assert.include(result.paths, "included.ts");
          assert.notInclude(result.paths, "debug.log");
          assert.notInclude(result.paths, "nested/error.log");
        }),
      );
    });

    describe("ignored path filtering", () => {
      it.effect("filters ignored paths", () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const driver = yield* VcsDriver;

          yield* input.fixture.createRepo(cwd);
          yield* input.fixture.ignorePath(cwd, "*.log");

          const result = yield* driver.filterIgnoredPaths(cwd, [
            "keep.ts",
            "debug.log",
            "nested/error.log",
          ]);

          assert.deepStrictEqual(result, ["keep.ts"]);
        }),
      );

      it.effect("returns empty input unchanged", () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const driver = yield* VcsDriver;

          yield* input.fixture.createRepo(cwd);

          assert.deepStrictEqual(yield* driver.filterIgnoredPaths(cwd, []), []);
        }),
      );
    });
  });
}

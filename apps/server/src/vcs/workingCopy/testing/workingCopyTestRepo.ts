/**
 * fork: f4 — a real temp git repository for the working-copy tests.
 *
 * The plan's rule for this feature is that the receipts are real git results,
 * not mocked stdout: every parser here is a guess about what git actually
 * prints, and only a real repository can falsify it.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";

import type { VcsError } from "@t3tools/contracts";
import { ServerConfig } from "../../../config.ts";
import * as GitVcsDriver from "../../GitVcsDriver.ts";
import * as VcsDriver from "../../VcsDriver.ts";
import * as VcsProcess from "../../VcsProcess.ts";
import { makeWorkingCopyGit, type WorkingCopyGit } from "../WorkingCopyGit.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-working-copy-test-",
});

export const WorkingCopyTestLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

export const makeTempDirectory = (
  prefix = "working-copy-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

export const writeFile = Effect.fn("workingCopyTestRepo.writeFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
  yield* fileSystem.writeFileString(target, contents);
});

export const removeFile = Effect.fn("workingCopyTestRepo.removeFile")(function* (
  cwd: string,
  relativePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.remove(path.join(cwd, relativePath));
});

export const readFile = Effect.fn("workingCopyTestRepo.readFile")(function* (
  cwd: string,
  relativePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem
    .readFileString(path.join(cwd, relativePath))
    .pipe(Effect.orElseSucceed(() => null));
});

/** Raw git, for arranging fixtures. Fails loudly on a non-zero exit. */
export const git = Effect.fn("workingCopyTestRepo.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const driver = yield* VcsDriver.VcsDriver;
  const output = yield* driver.execute({
    operation: "workingCopyTestRepo.git",
    cwd,
    args,
    allowNonZeroExit: true,
    timeoutMs: 20_000,
  });
  if (output.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${output.exitCode}): ${output.stderr}`);
  }
  return output.stdout;
});

/**
 * A repository with deterministic identity and no dependency on the host's
 * global git config (a `commit.gpgsign` or a `core.hooksPath` in the
 * developer's `~/.gitconfig` would otherwise make these tests flaky).
 */
export const initRepository = Effect.fn("workingCopyTestRepo.initRepository")(function* (
  cwd: string,
) {
  yield* git(cwd, ["init", "--initial-branch=main"]);
  yield* git(cwd, ["config", "user.email", "working-copy@test.invalid"]);
  yield* git(cwd, ["config", "user.name", "Working Copy Test"]);
  yield* git(cwd, ["config", "commit.gpgsign", "false"]);
  yield* git(cwd, ["config", "core.hooksPath", "/dev/null"]);
});

export interface WorkingCopyTestRepo {
  readonly cwd: string;
  readonly git: WorkingCopyGit;
}

/** A scoped temp repository plus the `WorkingCopyGit` every operation takes. */
export const makeTestRepository = Effect.fn("workingCopyTestRepo.makeTestRepository")(function* (
  prefix?: string,
): Effect.fn.Return<
  WorkingCopyTestRepo,
  PlatformError.PlatformError | VcsError,
  FileSystem.FileSystem | Scope.Scope | VcsDriver.VcsDriver
> {
  const cwd = yield* makeTempDirectory(prefix);
  const fileSystem = yield* FileSystem.FileSystem;
  // macOS temp dirs are behind a `/private` symlink; git reports the resolved
  // path, so the fixture must too or every path comparison drifts.
  const resolved = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
  yield* initRepository(resolved);
  const driver = yield* VcsDriver.VcsDriver;
  return { cwd: resolved, git: makeWorkingCopyGit(driver, resolved) };
});

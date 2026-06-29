import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

class ReplayFixtureGitCommandError extends Schema.TaggedErrorClass<ReplayFixtureGitCommandError>()(
  "ReplayFixtureGitCommandError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.command} failed with exit ${this.exitCode}.`;
  }
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<
  void,
  ReplayFixtureGitCommandError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }));
    if (Number(exitCode) !== 0) {
      return yield* new ReplayFixtureGitCommandError({
        command: `git ${args.join(" ")}`,
        exitCode: Number(exitCode),
      });
    }
  });
}

export const makeCheckpointWorkspaceEffect = Effect.fn("makeCheckpointWorkspace")(function* (
  fixtureName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory({
    prefix: `t3-orchestrator-v2-${fixtureName}-`,
  });
  yield* runGit(cwd, ["init"]);
  yield* runGit(cwd, ["config", "user.name", "T3 Code Test"]);
  yield* runGit(cwd, ["config", "user.email", "t3code-test@example.com"]);
  yield* fs.writeFileString(path.join(cwd, "README.md"), `# ${fixtureName}\n`);
  yield* runGit(cwd, ["add", "README.md"]);
  yield* runGit(cwd, ["commit", "-m", "initial"]);
  return cwd;
});

export const removeCheckpointWorkspaceEffect = Effect.fn("removeCheckpointWorkspace")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(cwd, { recursive: true });
});

export const checkpointWorkspace = (fixtureName: string) =>
  Effect.acquireRelease(makeCheckpointWorkspaceEffect(fixtureName), (cwd) =>
    removeCheckpointWorkspaceEffect(cwd).pipe(Effect.orDie),
  ).pipe(Effect.provide(NodeServices.layer));

export async function makeCheckpointWorkspace(fixtureName: string): Promise<string> {
  return await Effect.runPromise(
    makeCheckpointWorkspaceEffect(fixtureName).pipe(Effect.provide(NodeServices.layer)),
  );
}

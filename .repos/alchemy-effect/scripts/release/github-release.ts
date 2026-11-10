// Creates the GitHub release for a tag, marked Latest to match npm.
//
// `scripts/release/publish.ts` publishes every release, prereleases included,
// under npm's `latest` dist-tag, so every release is a plain (non-prerelease)
// GitHub release and the newest one is Latest; GitHub cannot mark a
// prerelease Latest. release.yml does not run this for tag releases. A tag
// that already has a release is skipped, so a failed run can be re-run.
//
// The notes cover the commits since the previous tag. Reads `ALCHEMY_REPO`
// (`<owner>/<repo>`) for the changelog's links.
//
// Usage: node scripts/release/github-release.ts <tag> <release|beta|alpha|rc>
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command } from "effect/cli";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { generate } from "./changelog.ts";
import { repository } from "./config.ts";

export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly message: string;
  readonly command: string;
  readonly exitCode: number;
}> {}

/** Runs a command, returning its exit code and captured stdout. */
const run = Effect.fn(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], { stdout: "pipe", stderr: "ignore" }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { exitCode: Number(exitCode), stdout: stdout.trim() };
    }),
  );
});

/** Runs a command with its output inherited, failing on a non-zero exit. */
const runOrFail = Effect.fn(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner;
  const exitCode = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], { stdout: "inherit", stderr: "inherit" }),
      );
      return Number(yield* handle.exitCode);
    }),
  );
  if (exitCode !== 0) {
    return yield* new CommandFailed({
      message: `${command} ${args[0] ?? ""} exited with code ${exitCode}`,
      command,
      exitCode,
    });
  }
});

const command = Command.make(
  "github-release",
  {
    tag: Argument.String("tag").pipe(Argument.withDescription("Release tag, e.g. v1.0.0-rc.14")),
    channel: Argument.Literals("channel", ["release", "beta", "alpha", "rc"]).pipe(
      Argument.withDescription("Release channel"),
    ),
  },
  Effect.fn(function* ({ tag, channel }) {
    if ((yield* run("gh", ["release", "view", tag])).exitCode === 0) {
      yield* Console.log(`Release ${tag} already exists on GitHub, skipping`);
      return;
    }

    const previous = yield* run("git", ["describe", "--tags", "--abbrev=0", `${tag}^`]);
    const from = previous.exitCode === 0 ? previous.stdout : undefined;

    yield* Console.log(
      `Generating ${channel} release notes for ${tag}${from ? ` from ${from}` : ""}`,
    );
    const { md } = yield* generate({ from, to: tag, repo: yield* repository });

    yield* runOrFail("gh", ["release", "create", tag, "--title", tag, "--notes", md, "--latest"]);
  }),
).pipe(Command.withDescription("Create the GitHub release for a tag, marked Latest"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);

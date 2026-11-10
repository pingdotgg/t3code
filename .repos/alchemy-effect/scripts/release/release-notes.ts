// Prepends the release notes for a tag to CHANGELOG.md. Idempotent: a tag
// that already has a heading in CHANGELOG.md is skipped.
//
// The notes cover the commits since the previous tag, up to the tag if it
// exists yet, otherwise HEAD. Reads `ALCHEMY_REPO` (`<owner>/<repo>`) for the
// changelog's links.
//
// Usage: node scripts/release/release-notes.ts <tag>
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command } from "effect/cli";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { generate } from "./changelog.ts";
import { repository } from "./config.ts";

/** Whether `tag` exists locally. */
const tagExists = Effect.fn(function* (tag: string) {
  const spawner = yield* ChildProcessSpawner;
  const exitCode = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      return yield* handle.exitCode;
    }),
  );
  return Number(exitCode) === 0;
});

const command = Command.make(
  "release-notes",
  {
    tag: Argument.String("tag").pipe(Argument.withDescription("Release tag, e.g. v2.0.0-beta.13")),
  },
  Effect.fn(function* ({ tag }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const changelogPath = path.resolve("CHANGELOG.md");

    const existing = (yield* fs.exists(changelogPath))
      ? yield* fs.readFileString(changelogPath)
      : "";
    if (existing.includes(`## ${tag}\n`)) {
      yield* Console.log(`${tag} already in CHANGELOG.md, skipping`);
      return;
    }

    const to = (yield* tagExists(tag)) ? tag : "HEAD";
    yield* Console.log(`Generating release notes for ${tag} (using ${to})`);
    const { md } = yield* generate({ to, repo: yield* repository });

    yield* fs.writeFileString(changelogPath, `## ${tag}\n\n${md}\n\n---\n\n${existing}`);
  }),
).pipe(Command.withDescription("Prepend the release notes for a tag to CHANGELOG.md"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);

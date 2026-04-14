#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };

interface NightlyReleaseMetadata {
  readonly baseVersion: string;
  readonly version: string;
  readonly tag: string;
  readonly name: string;
  readonly shortSha: string;
}

const DateSchema = Schema.String.check(Schema.isPattern(/^\d{8}$/));
const RunNumberSchema = Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(1));
const ShaSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/i));

const writeOutput = Effect.fn("writeOutput")(function* (
  metadata: NightlyReleaseMetadata,
  writeGithubOutput: boolean,
) {
  const fs = yield* FileSystem.FileSystem;

  const entries = [
    ["base_version", metadata.baseVersion],
    ["version", metadata.version],
    ["tag", metadata.tag],
    ["name", metadata.name],
    ["short_sha", metadata.shortSha],
  ] as const;

  if (writeGithubOutput) {
    const githubOutputPath = yield* Config.nonEmptyString("GITHUB_OUTPUT");
    const serialized = entries.map(([key, value]) => `${key}=${value}\n`).join("");
    yield* fs.writeFileString(githubOutputPath, serialized, { flag: "a" });
  } else {
    for (const [key, value] of entries) {
      console.log(`${key}=${value}`);
    }
  }
});

const command = Command.make(
  "resolve-nightly-release",
  {
    date: Flag.string("date").pipe(
      Flag.withSchema(DateSchema),
      Flag.withDescription("Nightly build date in YYYYMMDD."),
    ),
    runNumber: Flag.string("run-number").pipe(
      Flag.withSchema(RunNumberSchema),
      Flag.withDescription("GitHub Actions run number."),
    ),
    sha: Flag.string("sha").pipe(
      Flag.withSchema(ShaSchema),
      Flag.withDescription("Commit sha for the nightly build."),
    ),
    githubOutput: Flag.boolean("github-output").pipe(
      Flag.withDescription("Write values to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
  },
  ({ date, runNumber, sha, githubOutput }) =>
    writeOutput(
      {
        baseVersion: desktopPackageJson.version,
        version: `${desktopPackageJson.version}-nightly.${date}.${runNumber}`,
        tag: `nightly-v${desktopPackageJson.version}-nightly.${date}.${runNumber}`,
        name: `T3 Code Nightly ${desktopPackageJson.version}-nightly.${date}.${runNumber}`,
        shortSha: sha.slice(0, 12),
      },
      githubOutput,
    ),
).pipe(Command.withDescription("Resolve nightly release version metadata."));

Command.run(command, {
  version: "0.0.0",
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);

#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

interface NightlyReleaseMetadata {
  readonly baseVersion: string;
  readonly version: string;
  readonly tag: string;
  readonly name: string;
  readonly shortSha: string;
}

const DateSchema = Schema.String.check(Schema.isPattern(/^\d{8}$/));
const RunNumberSchema = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
);
const ShaSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/i));
const DesktopPackageJsonSchema = Schema.Struct({
  version: Schema.NonEmptyString,
});

export class InvalidDesktopPackageVersionError extends Schema.TaggedErrorClass<InvalidDesktopPackageVersionError>()(
  "InvalidDesktopPackageVersionError",
  {
    version: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid desktop package version '${this.version}'.`;
  }
}

export class NightlyReleaseDesktopPackageError extends Schema.TaggedErrorClass<NightlyReleaseDesktopPackageError>()(
  "NightlyReleaseDesktopPackageError",
  {
    operation: Schema.Literals(["read", "decode"]),
    packageJsonPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} desktop package metadata at ${this.packageJsonPath}.`;
  }
}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const decodeDesktopPackageJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopPackageJsonSchema),
);

export const resolveNightlyBaseVersion = (version: string) => version.replace(/[-+].*$/, "");

export const resolveNightlyTargetVersion = (version: string) => {
  const stableCore = resolveNightlyBaseVersion(version);
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(stableCore);
  if (!match) {
    return Effect.fail(new InvalidDesktopPackageVersionError({ version }));
  }

  const [, major, minor, patch] = match;
  return Effect.succeed(`${major}.${minor}.${Number(patch) + 1}`);
};

export const resolveNightlyReleaseMetadata = (
  baseVersion: string,
  date: string,
  runNumber: number,
  sha: string,
) => {
  const shortSha = sha.slice(0, 12);
  const version = `${baseVersion}-nightly.${date}.${runNumber}`;
  return {
    baseVersion,
    version,
    tag: `v${version}`,
    name: `T3 Code Nightly ${version} (${shortSha})`,
    shortSha,
  };
};

export const readDesktopBaseVersion = Effect.fn("readDesktopBaseVersion")(function* (
  rootDir: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = rootDir ? path.resolve(rootDir) : yield* RepoRoot;
  const packageJsonPath = path.join(workspaceRoot, "apps/desktop/package.json");
  const packageJsonSource = yield* fs.readFileString(packageJsonPath).pipe(
    Effect.mapError(
      (cause) =>
        new NightlyReleaseDesktopPackageError({
          operation: "read",
          packageJsonPath,
          cause,
        }),
    ),
  );
  const packageJson = yield* decodeDesktopPackageJson(packageJsonSource).pipe(
    Effect.mapError(
      (cause) =>
        new NightlyReleaseDesktopPackageError({
          operation: "decode",
          packageJsonPath,
          cause,
        }),
    ),
  );
  return yield* resolveNightlyTargetVersion(packageJson.version);
});

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
      yield* Console.log(`${key}=${value}`);
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
    root: Flag.string("root").pipe(
      Flag.withDescription("Workspace root used to resolve apps/desktop/package.json."),
      Flag.optional,
    ),
  },
  ({ date, runNumber, sha, githubOutput, root }) =>
    readDesktopBaseVersion(Option.getOrUndefined(root)).pipe(
      Effect.map((baseVersion) => resolveNightlyReleaseMetadata(baseVersion, date, runNumber, sha)),
      Effect.flatMap((metadata) => writeOutput(metadata, githubOutput)),
    ),
).pipe(Command.withDescription("Resolve nightly release version metadata."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}

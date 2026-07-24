#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

const ANDROID_VERSION_CODE_MAX = 2_100_000_000;
const DateSchema = Schema.String.check(Schema.isPattern(/^\d{8}$/));
const RunNumberSchema = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: ANDROID_VERSION_CODE_MAX }),
);
const ShaSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/i));
const DesktopPackageJsonSchema = Schema.Struct({ version: Schema.NonEmptyString });

export interface F8yReleaseMetadata {
  readonly baseVersion: string;
  readonly version: string;
  readonly tag: string;
  readonly name: string;
  readonly shortSha: string;
  readonly androidVersionCode: number;
}

export class InvalidF8yReleaseBaseVersionError extends Schema.TaggedErrorClass<InvalidF8yReleaseBaseVersionError>()(
  "InvalidF8yReleaseBaseVersionError",
  { version: Schema.String },
) {
  override get message(): string {
    return `Invalid desktop package version '${this.version}'.`;
  }
}

export class F8yReleaseDesktopPackageError extends Schema.TaggedErrorClass<F8yReleaseDesktopPackageError>()(
  "F8yReleaseDesktopPackageError",
  {
    operation: Schema.Literals(["read", "decode"]),
    packageJsonPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} f8y release package metadata at ${this.packageJsonPath}.`;
  }
}

export class F8yReleaseGitHubOutputError extends Schema.TaggedErrorClass<F8yReleaseGitHubOutputError>()(
  "F8yReleaseGitHubOutputError",
  {
    operation: Schema.Literals(["resolve", "append"]),
    outputPath: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.operation === "resolve"
      ? "Failed to resolve GITHUB_OUTPUT for f8y release metadata."
      : `Failed to append f8y release metadata to ${this.outputPath}.`;
  }
}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const decodeDesktopPackageJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopPackageJsonSchema),
);

export const resolveF8yReleaseBaseVersion = (version: string) => {
  const stableCore = version.replace(/[-+].*$/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(stableCore);
  if (!match) {
    return Effect.fail(new InvalidF8yReleaseBaseVersionError({ version }));
  }

  return Effect.succeed(stableCore);
};

export function resolveF8yReleaseMetadata(
  baseVersion: string,
  date: string,
  runNumber: number,
  sha: string,
): F8yReleaseMetadata {
  const shortSha = sha.slice(0, 12);
  const version = `${baseVersion}-f8y.${date}.${runNumber}`;
  return {
    baseVersion,
    version,
    tag: `v${version}`,
    name: `T3 Code f8y ${version} (${shortSha})`,
    shortSha,
    androidVersionCode: runNumber,
  };
}

export const readF8yReleaseBaseVersion = Effect.fn("readF8yReleaseBaseVersion")(function* (
  rootDir: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = rootDir ? path.resolve(rootDir) : yield* RepoRoot;
  const packageJsonPath = path.join(root, "apps/desktop/package.json");
  const source = yield* fs.readFileString(packageJsonPath).pipe(
    Effect.mapError(
      (cause) =>
        new F8yReleaseDesktopPackageError({
          operation: "read",
          packageJsonPath,
          cause,
        }),
    ),
  );
  const packageJson = yield* decodeDesktopPackageJson(source).pipe(
    Effect.mapError(
      (cause) =>
        new F8yReleaseDesktopPackageError({
          operation: "decode",
          packageJsonPath,
          cause,
        }),
    ),
  );
  return yield* resolveF8yReleaseBaseVersion(packageJson.version);
});

export const writeF8yReleaseMetadata = Effect.fn("writeF8yReleaseMetadata")(function* (
  metadata: F8yReleaseMetadata,
  githubOutput: boolean,
) {
  const entries = [
    ["base_version", metadata.baseVersion],
    ["version", metadata.version],
    ["tag", metadata.tag],
    ["name", metadata.name],
    ["short_sha", metadata.shortSha],
    ["android_version_code", String(metadata.androidVersionCode)],
  ] as const;

  if (!githubOutput) {
    for (const [key, value] of entries) {
      yield* Console.log(`${key}=${value}`);
    }
    return;
  }

  const fs = yield* FileSystem.FileSystem;
  const outputPath = yield* Config.nonEmptyString("GITHUB_OUTPUT").pipe(
    Effect.mapError((cause) => new F8yReleaseGitHubOutputError({ operation: "resolve", cause })),
  );
  const serialized = entries.map(([key, value]) => `${key}=${value}\n`).join("");
  yield* fs.writeFileString(outputPath, serialized, { flag: "a" }).pipe(
    Effect.mapError(
      (cause) =>
        new F8yReleaseGitHubOutputError({
          operation: "append",
          outputPath,
          cause,
        }),
    ),
  );
});

const command = Command.make(
  "resolve-f8y-release",
  {
    date: Flag.string("date").pipe(Flag.withSchema(DateSchema)),
    runNumber: Flag.string("run-number").pipe(Flag.withSchema(RunNumberSchema)),
    sha: Flag.string("sha").pipe(Flag.withSchema(ShaSchema)),
    root: Flag.string("root").pipe(Flag.optional),
    githubOutput: Flag.boolean("github-output").pipe(Flag.withDefault(false)),
  },
  ({ date, runNumber, sha, root, githubOutput }) =>
    readF8yReleaseBaseVersion(Option.getOrUndefined(root)).pipe(
      Effect.map((baseVersion) => resolveF8yReleaseMetadata(baseVersion, date, runNumber, sha)),
      Effect.flatMap((metadata) => writeF8yReleaseMetadata(metadata, githubOutput)),
    ),
).pipe(Command.withDescription("Resolve f8y continuous release metadata."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}

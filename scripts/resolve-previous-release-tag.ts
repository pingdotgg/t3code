#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Array, Config, Effect, FileSystem, Schema, Stream, String } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const ReleaseChannel = Schema.Literals(["stable", "nightly"]);
type ReleaseChannel = typeof ReleaseChannel.Type;

interface StableVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string>;
}

interface NightlyVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly date: number;
  readonly runNumber: number;
}

const parseNumericIdentifier = (identifier: string): number | undefined =>
  /^\d+$/.test(identifier) ? Number(identifier) : undefined;

const comparePrereleaseIdentifiers = (left: string, right: string): number => {
  const leftNumeric = parseNumericIdentifier(left);
  const rightNumeric = parseNumericIdentifier(right);

  if (leftNumeric !== undefined && rightNumeric !== undefined) {
    return leftNumeric - rightNumeric;
  }
  if (leftNumeric !== undefined) {
    return -1;
  }
  if (rightNumeric !== undefined) {
    return 1;
  }
  return left.localeCompare(right);
};

const compareStableVersions = (left: StableVersion, right: StableVersion): number => {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;

  const leftHasPrerelease = left.prerelease.length > 0;
  const rightHasPrerelease = right.prerelease.length > 0;
  if (!leftHasPrerelease && !rightHasPrerelease) return 0;
  if (!leftHasPrerelease) return 1;
  if (!rightHasPrerelease) return -1;

  const maxLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;

    const comparison = comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier);
    if (comparison !== 0) return comparison;
  }

  return 0;
};

const parseStableTag = (tag: string): StableVersion | undefined => {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag);
  if (!match) return undefined;

  const [, major, minor, patch, prerelease] = match;
  if (!major || !minor || !patch) return undefined;

  const prereleaseIdentifiers = prerelease ? prerelease.split(".") : [];
  // Nightly tags also start with `v` and carry a `nightly.*` prerelease
  // identifier. They must not be considered stable candidates when resolving
  // the previous stable tag.
  if (prereleaseIdentifiers[0] === "nightly") return undefined;

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prereleaseIdentifiers,
  };
};

const compareNightlyVersions = (left: NightlyVersion, right: NightlyVersion): number => {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.date !== right.date) return left.date - right.date;
  return left.runNumber - right.runNumber;
};

const parseNightlyTag = (tag: string): NightlyVersion | undefined => {
  // Accept both the current `v<semver>` format and the legacy `nightly-v<semver>`
  // format so release note diffs keep working across the tag-format transition.
  const match = /^(?:nightly-)?v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/.exec(tag);
  if (!match) return undefined;

  const [, major, minor, patch, date, runNumber] = match;
  if (!major || !minor || !patch || !date || !runNumber) return undefined;

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    date: Number(date),
    runNumber: Number(runNumber),
  };
};

const resolvePreviousReleaseTag = (
  channel: ReleaseChannel,
  currentTag: string,
  tags: ReadonlyArray<string>,
): string | undefined => {
  if (channel === "stable") {
    const current = parseStableTag(currentTag);
    if (!current) {
      throw new Error(`Invalid stable release tag '${currentTag}'.`);
    }

    const candidates = tags
      .map((tag) => ({ tag, parsed: parseStableTag(tag) }))
      .filter(
        (entry): entry is { tag: string; parsed: StableVersion } => entry.parsed !== undefined,
      )
      .filter((entry) => compareStableVersions(entry.parsed, current) < 0)
      .toSorted((left, right) => compareStableVersions(right.parsed, left.parsed));

    return candidates[0]?.tag;
  }

  const current = parseNightlyTag(currentTag);
  if (!current) {
    throw new Error(`Invalid nightly release tag '${currentTag}'.`);
  }

  const candidates = tags
    .map((tag) => ({ tag, parsed: parseNightlyTag(tag) }))
    .filter((entry): entry is { tag: string; parsed: NightlyVersion } => entry.parsed !== undefined)
    .filter((entry) => compareNightlyVersions(entry.parsed, current) < 0)
    .toSorted((left, right) => compareNightlyVersions(right.parsed, left.parsed));

  return candidates[0]?.tag;
};

const listGitTags = Effect.fn("listGitTags")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make("git", ["tag", "--list"]));
  const tags = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
    Effect.map(String.split(/\r?\n/)),
    Effect.map(Array.map(String.trim)),
    Effect.map(Array.filter(String.isNonEmpty)),
  );
  return tags;
});

const writeOutput = Effect.fn("writeOutput")(function* (
  previousTag: string | undefined,
  writeGithubOutput: boolean,
) {
  const entry = `previous_tag=${previousTag ?? ""}\n`;

  if (writeGithubOutput) {
    const fs = yield* FileSystem.FileSystem;
    const githubOutputPath = yield* Config.nonEmptyString("GITHUB_OUTPUT");
    yield* fs.writeFileString(githubOutputPath, entry, { flag: "a" });
    return;
  }

  process.stdout.write(entry);
});

const command = Command.make(
  "resolve-previous-release-tag",
  {
    channel: Flag.choice("channel", ReleaseChannel.literals).pipe(
      Flag.withDescription("Release channel whose previous tag should be resolved."),
    ),
    currentTag: Flag.string("current-tag").pipe(
      Flag.withDescription("Current release tag to compare against."),
    ),
    githubOutput: Flag.boolean("github-output").pipe(
      Flag.withDescription("Write values to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
  },
  ({ channel, currentTag, githubOutput }) =>
    listGitTags().pipe(
      Effect.map((tags) => resolvePreviousReleaseTag(channel, currentTag, tags)),
      Effect.flatMap((previousTag) => writeOutput(previousTag, githubOutput)),
    ),
).pipe(Command.withDescription("Resolve the previous release tag for a stable or nightly series."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}

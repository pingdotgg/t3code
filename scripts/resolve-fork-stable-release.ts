#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface ForkStableReleaseMetadata {
  readonly version: string;
  readonly tag: string;
  readonly name: string;
}

const forkMarker = "tarik02";

function parseArgs(argv: ReadonlyArray<string>): {
  readonly date: string;
  readonly root: string;
  readonly githubOutput: boolean;
  readonly versionOnly: boolean;
} {
  let date: string | undefined;
  let root = process.cwd();
  let githubOutput = false;
  let versionOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--date requires a value.");
      }
      date = value;
      index += 1;
      continue;
    }
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--root requires a value.");
      }
      root = NodePath.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--github-output") {
      githubOutput = true;
      continue;
    }
    if (arg === "--version-only") {
      versionOnly = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!date || !/^\d{8}$/.test(date)) {
    throw new Error("--date must use YYYYMMDD.");
  }

  return { date, root, githubOutput, versionOnly };
}

function readGitTags(root: string): ReadonlyArray<string> {
  return NodeChildProcess.execFileSync("git", ["tag", "--list"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((tag) => tag.length > 0);
}

export function resolveForkStableReleaseMetadata(
  date: string,
  tags: ReadonlyArray<string>,
): ForkStableReleaseMetadata {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const daySlot = day * 100;
  const tagPattern = new RegExp(
    `^v?${year}\\.${month}\\.([0-9]+)\\+${forkMarker}(?:\\.([0-9]+))?$`,
  );
  let maxSequence = 0;

  for (const tag of tags) {
    const match = tagPattern.exec(tag);
    if (!match) {
      continue;
    }

    const patch = Number(match[1]);
    if (patch < daySlot || patch >= daySlot + 100) {
      continue;
    }

    maxSequence = Math.max(maxSequence, patch - daySlot + 1);
  }

  const nextSequence = maxSequence + 1;
  const patch = daySlot + nextSequence - 1;
  const version = `${year}.${month}.${patch}+${forkMarker}`;
  return {
    version,
    tag: `v${version}`,
    name: `T3 Code v${version}`,
  };
}

function writeOutput(metadata: ForkStableReleaseMetadata, githubOutput: boolean): void {
  const entries = [
    ["version", metadata.version],
    ["tag", metadata.tag],
    ["name", metadata.name],
  ] as const;

  if (githubOutput) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath) {
      throw new Error("GITHUB_OUTPUT is not set.");
    }
    NodeFS.appendFileSync(outputPath, entries.map(([key, value]) => `${key}=${value}\n`).join(""));
    return;
  }

  for (const [key, value] of entries) {
    process.stdout.write(`${key}=${value}\n`);
  }
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const metadata = resolveForkStableReleaseMetadata(args.date, readGitTags(args.root));
  if (args.versionOnly) {
    process.stdout.write(`${metadata.version}\n`);
  } else {
    writeOutput(metadata, args.githubOutput);
  }
}

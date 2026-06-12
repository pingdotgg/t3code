#!/usr/bin/env node

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import process from "node:process";

import serverPackageJson from "../apps/server/package.json" with { type: "json" };

export type VersionBump = "major" | "minor" | "patch";

export interface PublishTargetVersionOptions {
  readonly bump: VersionBump;
  readonly version: string | null;
}

interface Options extends PublishTargetVersionOptions {
  readonly access: string;
  readonly dryRun: boolean;
  readonly otp: string | null;
  readonly provenance: boolean;
  readonly tag: string;
}

type MutableOptions = { -readonly [Key in keyof Options]: Options[Key] };

class PublishNpmError extends Data.TaggedError("PublishNpmError")<{
  readonly message: string;
}> {}

const DEFAULT_OPTIONS: Options = {
  access: "public",
  bump: "patch",
  dryRun: false,
  otp: null,
  provenance: false,
  tag: "latest",
  version: null,
};

const SEMVER_PATTERN = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:[-+][0-9A-Za-z.-]+)?$/u;

function usage(): string {
  return [
    "Usage: pnpm release:npm [--version <version> | --bump <major|minor|patch>] [flags]",
    "",
    "Flags:",
    "  --version <version>  Explicit npm package version to publish.",
    "  --bump <kind>        Bump kind when the current version is already published. Defaults to patch.",
    "  --tag <tag>          npm dist-tag. Defaults to latest.",
    "  --access <access>    npm access. Defaults to public.",
    "  --provenance         Pass --provenance to npm publish.",
    "  --dry-run            Run the full release flow with npm publish --dry-run.",
    "  --otp <code>         Use an OTP without prompting. Prefer the prompt for real publishes.",
    "  --help               Show this help.",
  ].join("\n");
}

function readOptionValue(args: ReadonlyArray<string>, index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function parseBump(value: string): VersionBump {
  if (value === "major" || value === "minor" || value === "patch") {
    return value;
  }
  throw new Error(`Invalid --bump value '${value}'. Expected major, minor, or patch.`);
}

function parseOptions(args: ReadonlyArray<string>): Options {
  const options: MutableOptions = {
    access: DEFAULT_OPTIONS.access,
    bump: DEFAULT_OPTIONS.bump,
    dryRun: DEFAULT_OPTIONS.dryRun,
    otp: DEFAULT_OPTIONS.otp,
    provenance: DEFAULT_OPTIONS.provenance,
    tag: DEFAULT_OPTIONS.tag,
    version: DEFAULT_OPTIONS.version,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--provenance") {
      options.provenance = true;
      continue;
    }

    if (arg === "--version") {
      options.version = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
      continue;
    }

    if (arg === "--bump") {
      options.bump = parseBump(readOptionValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith("--bump=")) {
      options.bump = parseBump(arg.slice("--bump=".length));
      continue;
    }

    if (arg === "--tag") {
      options.tag = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--tag=")) {
      options.tag = arg.slice("--tag=".length);
      continue;
    }

    if (arg === "--access") {
      options.access = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--access=")) {
      options.access = arg.slice("--access=".length);
      continue;
    }

    if (arg === "--otp") {
      options.otp = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--otp=")) {
      options.otp = arg.slice("--otp=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/u, "");
}

function assertValidVersion(version: string): void {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`Invalid version '${version}'. Expected a semver version like 1.2.3.`);
  }
}

export function bumpVersion(currentVersion: string, bump: VersionBump): string {
  const normalized = normalizeVersion(currentVersion);
  const match = SEMVER_PATTERN.exec(normalized);
  if (!match?.groups) {
    throw new Error(`Cannot bump invalid current version '${currentVersion}'.`);
  }

  const major = Number.parseInt(match.groups.major ?? "", 10);
  const minor = Number.parseInt(match.groups.minor ?? "", 10);
  const patch = Number.parseInt(match.groups.patch ?? "", 10);

  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    throw new Error(`Cannot bump invalid current version '${currentVersion}'.`);
  }

  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function readCurrentServerPackageName(): string {
  if (typeof serverPackageJson.name !== "string" || serverPackageJson.name.length === 0) {
    throw new Error("apps/server/package.json does not contain a string package name.");
  }
  return serverPackageJson.name;
}

function readCurrentServerVersion(): string {
  if (typeof serverPackageJson.version !== "string") {
    throw new Error("apps/server/package.json does not contain a string version.");
  }
  return serverPackageJson.version;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : JSON.stringify(value);
}

function redactArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.map((arg, index) => {
    if (args[index - 1] === "--otp") return "<redacted>";
    if (arg.startsWith("--otp=")) return "--otp=<redacted>";
    return arg;
  });
}

const runCommand = Effect.fn("runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly redact?: boolean },
) {
  const displayArgs = options?.redact ? redactArgs(args) : args;
  process.stdout.write(`\n$ ${[command, ...displayArgs].map(shellQuote).join(" ")}\n`);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, [...args], {
      cwd: process.cwd(),
      stderr: "inherit",
      stdout: "inherit",
      // Windows needs shell mode to resolve .cmd shims.
      shell: process.platform === "win32",
    }),
  );
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new PublishNpmError({
      message: `${command} exited with code ${exitCode}.`,
    });
  }
});

interface CapturedCommandResult {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
}

type VersionPublishedLookup = (version: string) => Promise<boolean>;

export interface PublishTargetVersionResolution {
  readonly targetVersion: string;
  readonly source: "explicit" | "current-unpublished" | "bumped-current-published";
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const captureCommand = Effect.fn("captureCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, [...args], {
      cwd: process.cwd(),
      stderr: "pipe",
      stdout: "pipe",
      shell: process.platform === "win32",
    }),
  );

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
    { concurrency: "unbounded" },
  );
  return { exitCode, stdout, stderr };
});

export function parseNpmVersionsJson(json: string): ReadonlySet<string> {
  const trimmed = json.trim();
  if (trimmed.length === 0) {
    throw new Error("npm view returned an empty versions response.");
  }

  const parsed = JSON.parse(trimmed) as unknown;
  const versions = new Set<string>();

  if (typeof parsed === "string") {
    versions.add(parsed);
    return versions;
  }

  if (Array.isArray(parsed)) {
    for (const value of parsed) {
      if (typeof value !== "string") {
        throw new Error("npm view returned a non-string version value.");
      }
      versions.add(value);
    }
    return versions;
  }

  throw new Error("npm view returned an unexpected versions response.");
}

function isNpmPackageNotFound(result: CapturedCommandResult): boolean {
  return /\bE404\b/u.test(`${result.stdout}\n${result.stderr}`);
}

export async function fetchPublishedNpmVersions(packageName: string): Promise<ReadonlySet<string>> {
  const result = await Effect.runPromise(
    captureCommand("npm", ["view", packageName, "versions", "--json"]).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );
  if (result.exitCode === 0) {
    return parseNpmVersionsJson(result.stdout);
  }

  if (isNpmPackageNotFound(result)) {
    return new Set();
  }

  const output = (result.stderr || result.stdout).trim();
  throw new Error(
    `Failed to check published npm versions for ${packageName}.${output ? `\n${output}` : ""}`,
  );
}

export async function resolvePublishTargetVersion(
  packageName: string,
  currentVersion: string,
  options: PublishTargetVersionOptions,
  isVersionPublished: VersionPublishedLookup,
): Promise<PublishTargetVersionResolution> {
  const normalizedCurrentVersion = normalizeVersion(currentVersion);
  assertValidVersion(normalizedCurrentVersion);

  if (options.version !== null) {
    const explicitVersion = normalizeVersion(options.version);
    assertValidVersion(explicitVersion);
    if (await isVersionPublished(explicitVersion)) {
      throw new Error(
        `${packageName}@${explicitVersion} is already published. Pass an unpublished --version value.`,
      );
    }
    return { targetVersion: explicitVersion, source: "explicit" };
  }

  if (!(await isVersionPublished(normalizedCurrentVersion))) {
    return { targetVersion: normalizedCurrentVersion, source: "current-unpublished" };
  }

  const bumpedVersion = bumpVersion(normalizedCurrentVersion, options.bump);
  if (await isVersionPublished(bumpedVersion)) {
    throw new Error(
      `${packageName}@${bumpedVersion} is already published. Update apps/server/package.json or pass an unpublished --version value.`,
    );
  }

  return { targetVersion: bumpedVersion, source: "bumped-current-published" };
}

async function createNpmVersionPublishedLookup(
  packageName: string,
): Promise<VersionPublishedLookup> {
  const publishedVersions = await fetchPublishedNpmVersions(packageName);
  return async (version) => publishedVersions.has(version);
}

async function run(
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly redact?: boolean },
) {
  await Effect.runPromise(
    runCommand(command, args, options).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Cannot prompt for npm OTP without an interactive terminal. Pass --otp instead.",
    );
  }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const previousRawMode = stdin.isRaw;
    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(previousRawMode);
      stdin.pause();
      stdout.write("\n");
    };

    const onData = (chunk: Buffer | string) => {
      const text = String(chunk);
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          process.exit(130);
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (char >= " " && char !== "\u007f") {
          value += char;
          stdout.write("*");
        }
      }
    };

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const packageName = readCurrentServerPackageName();
  const currentVersion = readCurrentServerVersion();
  const versionPublishedLookup = await createNpmVersionPublishedLookup(packageName);
  const resolution = await resolvePublishTargetVersion(
    packageName,
    currentVersion,
    options,
    versionPublishedLookup,
  );
  const targetVersion = resolution.targetVersion;

  if (resolution.source === "current-unpublished") {
    process.stdout.write(
      `${packageName}@${targetVersion} is not published yet; using current package version.\n`,
    );
  } else if (resolution.source === "bumped-current-published") {
    process.stdout.write(
      `${packageName}@${normalizeVersion(
        currentVersion,
      )} is already published; bumping to ${targetVersion}.\n`,
    );
  }

  process.stdout.write(
    `Preparing ${packageName}@${targetVersion} from current version ${currentVersion}.\n`,
  );

  await run("node", ["scripts/update-release-package-versions.ts", targetVersion]);
  await run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"]);
  await run("pnpm", ["fmt"]);
  await run("pnpm", ["lint"]);
  await run("pnpm", ["typecheck"]);
  await run("pnpm", ["--filter", "@t3tools/web", "build"]);
  await run("pnpm", ["--filter", "salchi", "build"]);

  const otp = options.otp ?? (options.dryRun ? null : await promptHidden("npm OTP: "));
  const publishArgs = [
    "apps/server/scripts/cli.ts",
    "publish",
    "--app-version",
    targetVersion,
    "--tag",
    options.tag,
    "--access",
    options.access,
    "--verbose",
  ];
  if (options.provenance) publishArgs.push("--provenance");
  if (options.dryRun) publishArgs.push("--dry-run");
  if (otp) publishArgs.push("--otp", otp);

  await run("node", publishArgs, { redact: true });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

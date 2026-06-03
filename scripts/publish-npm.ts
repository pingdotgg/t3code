#!/usr/bin/env node

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import process from "node:process";

import serverPackageJson from "../apps/server/package.json" with { type: "json" };

type VersionBump = "major" | "minor" | "patch";

interface Options {
  readonly access: string;
  readonly bump: VersionBump;
  readonly dryRun: boolean;
  readonly otp: string | null;
  readonly provenance: boolean;
  readonly tag: string;
  readonly version: string | null;
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
    "Usage: bun run release:npm [--version <version> | --bump <major|minor|patch>] [flags]",
    "",
    "Flags:",
    "  --version <version>  Explicit npm package version to publish.",
    "  --bump <kind>        Version bump when --version is omitted. Defaults to patch.",
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

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/u, "");
}

function assertValidVersion(version: string): void {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`Invalid version '${version}'. Expected a semver version like 1.2.3.`);
  }
}

function bumpVersion(currentVersion: string, bump: VersionBump): string {
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
        if (char === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " " && char !== "\u007f") {
          value += char;
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
  const currentVersion = readCurrentServerVersion();
  const targetVersion = normalizeVersion(
    options.version ?? bumpVersion(currentVersion, options.bump),
  );
  assertValidVersion(targetVersion);

  process.stdout.write(
    `Preparing salchi@${targetVersion} from current version ${currentVersion}.\n`,
  );

  await run("node", ["scripts/update-release-package-versions.ts", targetVersion]);
  await run("bun", ["install", "--lockfile-only", "--ignore-scripts"]);
  await run("bun", ["fmt"]);
  await run("bun", ["lint"]);
  await run("bun", ["typecheck"]);
  await run("bun", ["--filter", "@t3tools/web", "build"]);
  await run("bun", ["--filter", "salchi", "build"]);

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

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

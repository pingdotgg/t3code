// Picks the release version and stamps it on every publishable package.
//
// The packages' `package.json` version is the source of truth: every package
// must carry the same one (anything else fails), and the spec bumps from it.
// npm and git tags are never consulted.
//
// - `beta` (default), `rc` or `alpha`: the next candidate on that channel.
//   `2.0.0-beta.81` becomes `2.0.0-beta.82`; `2.0.0-beta.81` with `rc`
//   becomes `2.0.0-rc.1`. Moving to an earlier channel, or starting one from
//   a stable version, needs an explicit version.
// - `beta.N`, `rc.N`, `alpha.N`: that candidate of the current version.
// - `patch` / `minor` / `major`: the semver bump, so a prerelease graduates
//   (`2.0.0-beta.81` with `major` becomes `2.0.0`).
// - `x.y.z` or `x.y.z-<channel>.N`: exactly that version.
// - anything else: `0.0.0-<spec>`, a tag release that is published but never
//   committed, so it does not move the version later releases bump from.
//
// Every version except a tag release must be newer than the current one.
//
// Writes the version into each `packages/*/package.json`, records the
// packages in `release-packages.json`, refreshes the lockfile and validates
// the result (`scripts/validate-publish-packages.ts`). stdout
// carries only `version=` and `channel=` lines for `$GITHUB_OUTPUT`;
// everything else goes to stderr.
//
// Usage: node scripts/release/prepare.ts [spec]
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import { Argument, Command } from "effect/cli";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as SemVer from "effect/SemVer";
import * as Stream from "effect/Stream";
import { publishablePackages, sharedVersion } from "../package-manifest.ts";

const PRERELEASE_CHANNELS = ["alpha", "beta", "rc"] as const;
type PrereleaseChannel = (typeof PRERELEASE_CHANNELS)[number];
type Channel = "release" | PrereleaseChannel | "tag";

export class InvalidReleaseSpec extends Data.TaggedError("InvalidReleaseSpec")<{
  readonly message: string;
  readonly spec: string;
}> {}

export class InvalidCurrentVersion extends Data.TaggedError("InvalidCurrentVersion")<{
  readonly message: string;
  readonly version: string;
}> {}

export class VersionNotNewer extends Data.TaggedError("VersionNotNewer")<{
  readonly message: string;
  readonly current: string;
  readonly next: string;
}> {}

export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly message: string;
  readonly command: string;
  readonly exitCode: number;
}> {}

/** `x.y.z` with an optional `-<channel>.N`. */
interface Version {
  readonly core: readonly [number, number, number];
  readonly pre?: { readonly channel: PrereleaseChannel; readonly n: number };
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;

const parse = (text: string): Version | undefined => {
  const match = text.match(VERSION);
  if (!match) return undefined;
  const [, major, minor, patch, channel, n] = match;
  return {
    core: [Number(major), Number(minor), Number(patch)],
    pre: channel ? { channel: channel as PrereleaseChannel, n: Number(n) } : undefined,
  };
};

const format = ({ core, pre }: Version) =>
  `${core.join(".")}${pre ? `-${pre.channel}.${pre.n}` : ""}`;

/** The version `spec` selects, bumped from `current`. */
const nextVersion = Effect.fn(function* (
  current: Version,
  spec: string,
): Effect.fn.Return<Version, InvalidReleaseSpec> {
  const invalid = (reason: string) =>
    new InvalidReleaseSpec({ message: `Cannot release ${spec}: ${reason}`, spec });

  const prerelease = spec.match(/^(alpha|beta|rc)(?:\.(\d+))?$/);
  if (prerelease) {
    const channel = prerelease[1] as PrereleaseChannel;
    if (prerelease[2] !== undefined) {
      return { core: current.core, pre: { channel, n: Number(prerelease[2]) } };
    }
    if (!current.pre) {
      return yield* invalid(`${format(current)} is stable; pass an explicit x.y.z-${channel}.N`);
    }
    return {
      core: current.core,
      pre: { channel, n: current.pre.channel === channel ? current.pre.n + 1 : 1 },
    };
  }

  if (spec === "patch" || spec === "minor" || spec === "major") {
    const [major, minor, patch] = current.core;
    // A prerelease graduates to its own version when that already is the bump.
    if (spec === "major") {
      return { core: current.pre && minor === 0 && patch === 0 ? current.core : [major + 1, 0, 0] };
    }
    if (spec === "minor") {
      return { core: current.pre && patch === 0 ? current.core : [major, minor + 1, 0] };
    }
    return { core: current.pre ? current.core : [major, minor, patch + 1] };
  }

  const exact = parse(spec);
  if (exact) return exact;
  return yield* invalid("expected rc, beta, alpha, <channel>.N, patch, minor, major or x.y.z");
});

const resolveVersion = Effect.fn(function* (currentText: string, spec: string) {
  // Anything that is not a version bump is a tag release.
  if (
    /^[A-Za-z][A-Za-z0-9.-]*$/.test(spec) &&
    !/^(alpha|beta|rc)(\.\d+)?$|^(patch|minor|major)$/.test(spec)
  ) {
    return { channel: "tag" as Channel, version: `0.0.0-${spec}` };
  }

  const current = parse(currentText);
  if (!current) {
    return yield* new InvalidCurrentVersion({
      message: `The packages' version ${currentText} is not x.y.z or x.y.z-<alpha|beta|rc>.N`,
      version: currentText,
    });
  }
  const next = yield* nextVersion(current, spec);
  if (
    SemVer.isLessThanOrEqualTo(SemVer.parseUnsafe(format(next)), SemVer.parseUnsafe(currentText))
  ) {
    return yield* new VersionNotNewer({
      message: `${format(next)} is not newer than the current ${currentText}`,
      current: currentText,
      next: format(next),
    });
  }
  return { channel: (next.pre?.channel ?? "release") as Channel, version: format(next) };
});

/** Runs a command; stdout is captured (and echoed to stderr), stderr inherited. */
const runOrFail = Effect.fn(function* (command: string, args: ReadonlyArray<string>, cwd: string) {
  const spawner = yield* ChildProcessSpawner;
  const { stdout, exitCode } = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], { cwd, stdout: "pipe", stderr: "inherit" }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { stdout: stdout.trim(), exitCode: Number(exitCode) };
    }),
  );
  if (stdout) yield* Console.error(stdout);
  if (exitCode !== 0) {
    const line = [command, ...args].join(" ");
    return yield* new CommandFailed({
      message: `${line} exited with code ${exitCode}`,
      command: line,
      exitCode,
    });
  }
});

const command = Command.make(
  "prepare",
  {
    spec: Argument.String("spec").pipe(
      Argument.withDescription("Release spec (see the header of this file); defaults to beta"),
      Argument.optional,
    ),
  },
  Effect.fn(function* ({ spec }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "../..");

    const packages = yield* publishablePackages(root, "packages");
    const current = yield* sharedVersion(packages);

    const { channel, version } = yield* resolveVersion(
      current,
      Option.getOrElse(spec, () => "").trim() || "beta",
    );
    yield* Console.error(
      `Releasing ${packages.length} packages at ${version} (${channel}), from ${current}`,
    );

    yield* Effect.forEach(packages, (pkg) =>
      fs.writeFileString(
        path.join(root, pkg.dir, "package.json"),
        `${JSON.stringify({ ...pkg.raw, version }, null, 2)}\n`,
      ),
    );
    yield* fs.writeFileString(
      path.join(root, "release-packages.json"),
      `${JSON.stringify(
        packages.map(({ dir, manifest }) => ({ dir, name: manifest.name })),
        null,
        2,
      )}\n`,
    );

    yield* runOrFail("pnpm", ["install", "--lockfile-only"], root);
    yield* runOrFail("node", ["scripts/validate-publish-packages.ts"], root);

    yield* Console.log(`version=${version}`);
    yield* Console.log(`channel=${channel}`);
  }),
).pipe(Command.withDescription("Bump every package from the version they share"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  // Report failures on stderr: stdout is reserved for `$GITHUB_OUTPUT`.
  Effect.catchCause((cause) =>
    cause.pipe(
      Cause.pretty,
      Console.error,
      Effect.andThen(Effect.sync(() => (process.exitCode = 1))),
    ),
  ),
  NodeRuntime.runMain,
);

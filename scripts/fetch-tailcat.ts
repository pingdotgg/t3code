#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  TailcatArchiveError,
  extractArchiveEntries,
  tailcatArchiveFormat,
} from "./lib/tailcat-archive.ts";
import {
  sha256Hex,
  verifyTailcatDist,
  writeTailcatDist,
  type TailcatProvenance,
} from "./lib/tailcat-dist.ts";
import {
  TAILCAT_DIST_RELATIVE_PATH,
  TAILCAT_LICENSE_RELATIVE_PATH,
  TAILCAT_MANIFEST_RELATIVE_PATH,
  TAILCAT_PLATFORM_KEYS,
  TailcatManifestError,
  TailcatPlatformKey,
  encodeTailcatManifestJson,
  goTargetForPlatformKey,
  isTailcatPlatformKey,
  parseChecksumsFile,
  parseGitLsRemoteCommit,
  parseGoModGoVersion,
  readTailcatManifest,
  replaceTailcatVersion,
  resolveTailcatTarget,
  summarizeTailcatManifestChanges,
  tailcatHostPlatformKey,
  tailcatManifestPlatformKeys,
  tailcatReleaseAssetUrl,
  updateTailcatManifest,
  validateTailcatManifest,
  type TailcatManifest,
  type TailcatTarget,
} from "./lib/tailcat-manifest.ts";

/**
 * Stages the pinned Tailcat CLI for one or every platform.
 *
 *   node scripts/fetch-tailcat.ts                      # this machine, into native/tailcat/dist/<key>/
 *   node scripts/fetch-tailcat.ts --platform linux-arm64
 *   node scripts/fetch-tailcat.ts --all                # every pinned key (darwin needs Go)
 *   node scripts/fetch-tailcat.ts --verify [--all]     # re-check staged binaries, non-zero on drift
 *   node scripts/fetch-tailcat.ts --verify --manifest-only
 *   node scripts/fetch-tailcat.ts --update 0.6.0       # re-pin manifest.json to a new upstream version
 *
 * Nothing here ever resolves "latest": every download is the exact archive the
 * manifest names, checked against the manifest digest before it is opened, and
 * every source build is the pinned tag checked against the pinned commit.
 */

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

const textDecoder = new TextDecoder();

// --- errors -----------------------------------------------------------------

export class TailcatPlatformSelectionError extends Schema.TaggedErrorClass<TailcatPlatformSelectionError>()(
  "TailcatPlatformSelectionError",
  {
    reason: Schema.Literals(["unsupported-host", "unknown-platform", "not-pinned"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported-host":
        return `Tailcat has no build for this machine (${this.detail}). Pass --platform <key> to stage another platform.`;
      case "unknown-platform":
        return `Unknown platform key ${this.detail}. Expected one of: ${TAILCAT_PLATFORM_KEYS.join(", ")}.`;
      case "not-pinned":
        return `native/tailcat/manifest.json does not pin a binary for ${this.detail}.`;
    }
  }
}

export class TailcatDownloadError extends Schema.TaggedErrorClass<TailcatDownloadError>()(
  "TailcatDownloadError",
  {
    url: Schema.String,
    reason: Schema.Literals(["request-failed", "digest-mismatch", "checksum-conflict"]),
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = this.detail === undefined ? "" : ` ${this.detail}.`;
    switch (this.reason) {
      case "request-failed":
        return `Could not download ${this.url}.${detail}`;
      case "digest-mismatch":
        return `Refusing ${this.url}: its SHA-256 does not match native/tailcat/manifest.json.${detail} Re-download, or re-pin with --update if upstream republished the release.`;
      case "checksum-conflict":
        return `Refusing ${this.url}: the downloaded bytes disagree with the release's checksums.txt.${detail}`;
    }
  }
}

export class TailcatSourceBuildError extends Schema.TaggedErrorClass<TailcatSourceBuildError>()(
  "TailcatSourceBuildError",
  {
    platformKey: TailcatPlatformKey,
    reason: Schema.Literals([
      "tool-missing",
      "command-failed",
      "commit-mismatch",
      "output-missing",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "tool-missing":
        return `Building tailcat for ${this.platformKey} from source needs \`${this.detail}\` on PATH. Install it (Go version: native/tailcat/manifest.json source.goVersion), or point T3CODE_TAILCAT_BINARY at an existing tailcat binary.`;
      case "command-failed":
        return `Building tailcat for ${this.platformKey} from source failed: ${this.detail}`;
      case "commit-mismatch":
        return `Refusing to build tailcat for ${this.platformKey}: ${this.detail}. The upstream tag no longer matches the pinned commit; re-pin with --update after reviewing.`;
      case "output-missing":
        return `go build for ${this.platformKey} succeeded but produced no binary at ${this.detail}.`;
    }
  }
}

export class TailcatUpdateError extends Schema.TaggedErrorClass<TailcatUpdateError>()(
  "TailcatUpdateError",
  {
    version: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Could not re-pin tailcat to ${this.version}: ${this.detail}`;
  }
}

// --- process and network helpers ----------------------------------------------

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const collectCommandStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  mirror: NodeJS.WriteStream | undefined,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => "",
      (acc, chunk) =>
        Effect.as(
          mirror === undefined
            ? Effect.void
            : Effect.sync(() => {
                mirror.write(chunk);
              }),
          acc + chunk,
        ),
    ),
  );

const runCommand = Effect.fn("runCommand")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly verbose: boolean;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawn = yield* resolveSpawnCommand(input.command, input.args);
  const child = yield* spawner.spawn(
    ChildProcess.make(spawn.command, spawn.args, {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.env === undefined ? {} : { env: input.env, extendEnv: true }),
      shell: spawn.shell,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectCommandStream(child.stdout, input.verbose ? process.stdout : undefined),
      collectCommandStream(child.stderr, input.verbose ? process.stderr : undefined),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode } satisfies CommandResult;
}, Effect.scoped);

const outputTail = (result: CommandResult): string =>
  `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-20).join("\n");

const download = Effect.fn("download")(function* (url: string) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({ retryOn: "errors-and-responses", times: 3 }),
  );
  const bytes = yield* client.get(url).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError((cause) => new TailcatDownloadError({ url, reason: "request-failed", cause })),
  );
  yield* Effect.log(`[fetch-tailcat] Downloaded ${url} (${bytes.length} bytes)`);
  return bytes;
});

const downloadText = Effect.fn("downloadText")(function* (url: string) {
  return textDecoder.decode(yield* download(url));
});

const timestamp = Effect.map(DateTime.now, DateTime.formatIso);

// --- fetch ------------------------------------------------------------------

const fetchReleaseBinary = Effect.fn("fetchReleaseBinary")(function* (input: {
  readonly manifest: TailcatManifest;
  readonly target: Extract<TailcatTarget, { readonly kind: "release" }>;
  readonly distRoot: string;
}) {
  const { target } = input;
  const archive = yield* download(target.url);
  const archiveDigest = sha256Hex(archive);
  if (archiveDigest !== target.sha256) {
    return yield* new TailcatDownloadError({
      url: target.url,
      reason: "digest-mismatch",
      detail: `Expected ${target.sha256}, downloaded ${archiveDigest}`,
    });
  }

  const format = tailcatArchiveFormat(target.file);
  if (format === undefined) {
    return yield* new TailcatArchiveError({ archive: target.file, reason: "unsupported-format" });
  }
  const entries = yield* extractArchiveEntries({
    archive: target.file,
    bytes: archive,
    format,
    wanted: [target.executable, "LICENSE"],
  });
  const binary = entries.get(target.executable);
  if (binary === undefined) {
    return yield* new TailcatArchiveError({
      archive: target.file,
      reason: "entry-missing",
      detail: target.executable,
    });
  }

  const provenance: TailcatProvenance = {
    name: "tailcat",
    version: input.manifest.version,
    platformKey: target.platformKey,
    executable: target.executable,
    sha256: sha256Hex(binary),
    size: binary.length,
    origin: { kind: "release", url: target.url, sha256: archiveDigest },
    fetchedAt: yield* timestamp,
  };
  const written = yield* writeTailcatDist({
    distRoot: input.distRoot,
    provenance,
    binary,
    license: entries.get("LICENSE"),
  });
  yield* Effect.log(
    `[fetch-tailcat] ${target.platformKey}: staged ${written.binaryPath} (sha256 ${provenance.sha256})`,
  );
});

/**
 * Clones the pinned tag, refuses to continue unless HEAD is the pinned commit,
 * and compiles with the upstream build tags and ldflags. `-trimpath`,
 * `-buildvcs=false`, and CGO_ENABLED=0 make the output a function of the
 * source and the Go toolchain alone, so a cross-compiled darwin binary from a
 * Linux publisher is byte-identical to one built on a macOS runner.
 */
const buildTailcatFromSource = Effect.fn("buildTailcatFromSource")(function* (input: {
  readonly manifest: TailcatManifest;
  readonly platformKey: TailcatPlatformKey;
  readonly executable: string;
  readonly distRoot: string;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { manifest, platformKey } = input;
  const goTarget = goTargetForPlatformKey(platformKey);
  const tag = `v${manifest.version}`;
  const fail = (reason: TailcatSourceBuildError["reason"], detail: string) =>
    new TailcatSourceBuildError({ platformKey, reason, detail });
  const git = (args: ReadonlyArray<string>, verbose: boolean) =>
    runCommand({ command: "git", args, verbose }).pipe(
      Effect.mapError(() => fail("tool-missing", "git")),
    );

  const goVersion = yield* runCommand({ command: "go", args: ["version"], verbose: false }).pipe(
    Effect.mapError(() => fail("tool-missing", "go")),
  );
  if (goVersion.exitCode !== 0) {
    return yield* fail("tool-missing", "go");
  }

  const workDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tailcat-build-" });
  const sourceDir = path.join(workDir, "tailcat");
  yield* Effect.log(`[fetch-tailcat] ${platformKey}: cloning ${manifest.repository} at ${tag}`);
  const clone = yield* git(
    [
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      tag,
      "--config",
      "advice.detachedHead=false",
      manifest.repository,
      sourceDir,
    ],
    input.verbose,
  );
  if (clone.exitCode !== 0) {
    return yield* fail(
      "command-failed",
      `git clone exited ${clone.exitCode}\n${outputTail(clone)}`,
    );
  }

  const head = yield* git(["-C", sourceDir, "rev-parse", "HEAD"], false);
  const commit = head.stdout.trim();
  if (head.exitCode !== 0 || commit !== manifest.source.commit) {
    return yield* fail(
      "commit-mismatch",
      `tag ${tag} resolves to ${commit || "(unknown)"} but the manifest pins ${manifest.source.commit}`,
    );
  }

  const buildTags = (yield* fs.readFileString(
    path.join(sourceDir, manifest.source.buildTagsFile),
  )).trim();
  const outputPath = path.join(workDir, "out", input.executable);
  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  yield* Effect.log(
    `[fetch-tailcat] ${platformKey}: go build ${goTarget.goos}/${goTarget.goarch} with ${goVersion.stdout.trim()}`,
  );
  const build = yield* runCommand({
    command: "go",
    args: [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-tags",
      buildTags,
      "-ldflags",
      manifest.source.ldflags,
      "-o",
      outputPath,
      manifest.source.package,
    ],
    cwd: sourceDir,
    env: {
      CGO_ENABLED: "0",
      GOOS: goTarget.goos,
      GOARCH: goTarget.goarch,
      GOFLAGS: "-mod=readonly",
    },
    verbose: input.verbose,
  }).pipe(Effect.mapError(() => fail("tool-missing", "go")));
  if (build.exitCode !== 0) {
    return yield* fail("command-failed", `go build exited ${build.exitCode}\n${outputTail(build)}`);
  }

  const binary = yield* fs
    .readFile(outputPath)
    .pipe(Effect.mapError(() => fail("output-missing", outputPath)));
  const license = yield* fs.readFile(path.join(sourceDir, "LICENSE")).pipe(Effect.option);
  const provenance: TailcatProvenance = {
    name: "tailcat",
    version: manifest.version,
    platformKey,
    executable: input.executable,
    sha256: sha256Hex(binary),
    size: binary.length,
    origin: {
      kind: "source",
      repository: manifest.repository,
      tag,
      commit,
      goVersion: goVersion.stdout.trim(),
      goos: goTarget.goos,
      goarch: goTarget.goarch,
    },
    fetchedAt: yield* timestamp,
  };
  const written = yield* writeTailcatDist({
    distRoot: input.distRoot,
    provenance,
    binary,
    license: Option.getOrUndefined(license),
  });
  yield* Effect.log(
    `[fetch-tailcat] ${platformKey}: built ${written.binaryPath} from ${commit.slice(0, 12)} (sha256 ${provenance.sha256})`,
  );
}, Effect.scoped);

const fetchPlatform = Effect.fn("fetchPlatform")(function* (input: {
  readonly manifest: TailcatManifest;
  readonly platformKey: TailcatPlatformKey;
  readonly distRoot: string;
  readonly buildFromSource: boolean;
  readonly verbose: boolean;
}) {
  const path = yield* Path.Path;
  const { manifest, platformKey } = input;

  const staged = yield* verifyTailcatDist({ distRoot: input.distRoot, platformKey, manifest }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("TailcatDistError", () => Effect.succeed(Option.none<TailcatProvenance>())),
  );
  if (Option.isSome(staged)) {
    yield* Effect.log(
      `[fetch-tailcat] ${platformKey}: already staged and verified (${staged.value.origin.kind}, sha256 ${staged.value.sha256}); delete ${path.join(input.distRoot, platformKey)} to refetch`,
    );
    return;
  }

  const target = resolveTailcatTarget(manifest, platformKey);
  if (target === undefined) {
    return yield* new TailcatPlatformSelectionError({ reason: "not-pinned", detail: platformKey });
  }
  if (target.kind === "source") {
    yield* Effect.log(
      `[fetch-tailcat] ${platformKey}: upstream publishes no archive for this platform; building from source`,
    );
  }
  if (target.kind === "source" || input.buildFromSource) {
    return yield* buildTailcatFromSource({
      manifest,
      platformKey,
      executable: target.executable,
      distRoot: input.distRoot,
      verbose: input.verbose,
    });
  }
  yield* fetchReleaseBinary({ manifest, target, distRoot: input.distRoot });
});

const selectPlatformKeys = Effect.fn("selectPlatformKeys")(function* (
  manifest: TailcatManifest,
  flags: { readonly platform: Option.Option<string>; readonly all: boolean },
) {
  const pinned = tailcatManifestPlatformKeys(manifest);
  if (flags.all) {
    return pinned;
  }
  if (Option.isSome(flags.platform)) {
    const requested = flags.platform.value;
    if (!isTailcatPlatformKey(requested)) {
      return yield* new TailcatPlatformSelectionError({
        reason: "unknown-platform",
        detail: requested,
      });
    }
    if (!pinned.includes(requested)) {
      return yield* new TailcatPlatformSelectionError({ reason: "not-pinned", detail: requested });
    }
    return [requested];
  }
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const hostKey = tailcatHostPlatformKey(platform, architecture);
  if (hostKey === undefined) {
    return yield* new TailcatPlatformSelectionError({
      reason: "unsupported-host",
      detail: `${platform}/${architecture}`,
    });
  }
  return [hostKey];
});

// --- update -----------------------------------------------------------------

/**
 * Re-pins the manifest to another upstream version. Digests are computed from
 * the downloaded archives themselves and cross-checked against the release's
 * checksums.txt, the tag is resolved to a commit with `git ls-remote`, the Go
 * toolchain line follows upstream's go.mod, and the vendored LICENSE copy is
 * refreshed from the tag. Prints a field-by-field summary of what changed.
 */
const updateManifestPin = Effect.fn("updateManifestPin")(function* (input: {
  readonly repoRoot: string;
  readonly manifestPath: string;
  readonly requestedVersion: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const version = input.requestedVersion.trim().replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    return yield* new TailcatUpdateError({
      version: input.requestedVersion,
      detail: "expected a release version such as 0.6.0 or v0.6.0",
    });
  }
  const before = yield* readTailcatManifest(input.manifestPath);
  const tag = `v${version}`;
  const rename = (value: string) => replaceTailcatVersion(value, before.version, version);
  const releaseBaseUrl = rename(before.releaseBaseUrl);

  const published = parseChecksumsFile(
    yield* downloadText(tailcatReleaseAssetUrl(releaseBaseUrl, "checksums.txt")),
  );
  const assetDigests = new Map<string, string>();
  for (const [platformKey, asset] of Object.entries(before.assets)) {
    const file = rename(asset.file);
    const url = tailcatReleaseAssetUrl(releaseBaseUrl, file);
    const digest = sha256Hex(yield* download(url));
    const publishedDigest = published.get(file);
    if (publishedDigest !== undefined && publishedDigest !== digest) {
      return yield* new TailcatDownloadError({
        url,
        reason: "checksum-conflict",
        detail: `checksums.txt lists ${publishedDigest}, downloaded ${digest}`,
      });
    }
    if (publishedDigest === undefined) {
      yield* Effect.logWarning(
        `[fetch-tailcat] checksums.txt does not list ${file}; trusting the downloaded digest`,
      );
    }
    assetDigests.set(platformKey, digest);
  }

  const sourceSha256 = sha256Hex(yield* download(rename(before.source.url)));
  const lsRemote = yield* runCommand({
    command: "git",
    args: ["ls-remote", "--tags", before.repository, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    verbose: false,
  }).pipe(
    Effect.mapError(
      () =>
        new TailcatUpdateError({ version, detail: "git is required to resolve the tag commit" }),
    ),
  );
  const commit = parseGitLsRemoteCommit(lsRemote.stdout, tag);
  if (lsRemote.exitCode !== 0 || commit === undefined) {
    return yield* new TailcatUpdateError({
      version,
      detail: `tag ${tag} was not found in ${before.repository}\n${outputTail(lsRemote)}`.trim(),
    });
  }
  const goVersion = parseGoModGoVersion(
    yield* downloadText(`${before.repository}/raw/${tag}/go.mod`),
  );
  if (goVersion === undefined) {
    yield* Effect.logWarning(
      `[fetch-tailcat] could not read the go directive from upstream go.mod; keeping goVersion ${before.source.goVersion}`,
    );
  }

  const updated = updateTailcatManifest(before, {
    version,
    assetDigests,
    source: { sha256: sourceSha256, commit, goVersion },
  });
  if (Result.isFailure(updated)) {
    return yield* new TailcatUpdateError({ version, detail: updated.failure });
  }
  const problems = validateTailcatManifest(updated.success);
  if (problems.length > 0) {
    return yield* new TailcatManifestError({ manifestPath: input.manifestPath, problems });
  }
  yield* fs.writeFileString(
    input.manifestPath,
    `${yield* encodeTailcatManifestJson(updated.success)}\n`,
  );

  const licensePath = path.join(input.repoRoot, TAILCAT_LICENSE_RELATIVE_PATH);
  const license = yield* download(`${before.repository}/raw/${tag}/LICENSE`);
  const currentLicense = yield* fs.readFile(licensePath).pipe(Effect.option);
  const licenseChanged =
    Option.isNone(currentLicense) || sha256Hex(currentLicense.value) !== sha256Hex(license);
  if (licenseChanged) {
    yield* fs.writeFile(licensePath, license);
  }

  const changes = summarizeTailcatManifestChanges(before, updated.success);
  yield* Console.log(`Re-pinned ${TAILCAT_MANIFEST_RELATIVE_PATH} to tailcat ${version}:`);
  for (const change of changes.length > 0 ? changes : ["(no changes)"]) {
    yield* Console.log(`  ${change}`);
  }
  yield* Console.log(
    licenseChanged
      ? `  ${TAILCAT_LICENSE_RELATIVE_PATH}: refreshed from ${tag}; review the diff`
      : `  ${TAILCAT_LICENSE_RELATIVE_PATH}: unchanged`,
  );
  yield* Console.log(
    "Next: node scripts/fetch-tailcat.ts --all (darwin builds need Go), then bump TAILCAT_COMPATIBLE_RANGE in packages/tailcat/src/manifest.ts if the major or minor changed.",
  );
});

// --- command ----------------------------------------------------------------

export const fetchTailcatCommand = Command.make(
  "fetch-tailcat",
  {
    platform: Flag.string("platform").pipe(
      Flag.withDescription(
        `Platform key to stage (${TAILCAT_PLATFORM_KEYS.join(", ")}). Defaults to this machine.`,
      ),
      Flag.optional,
    ),
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Stage or verify every platform key the manifest pins."),
    ),
    verify: Flag.boolean("verify").pipe(
      Flag.withDescription(
        "Re-check staged binaries against the manifest instead of fetching; exits non-zero when one is missing or does not match.",
      ),
    ),
    manifestOnly: Flag.boolean("manifest-only").pipe(
      Flag.withDescription(
        "Only validate native/tailcat/manifest.json (schema and per-platform pins). No network, no binaries.",
      ),
    ),
    out: Flag.string("out").pipe(
      Flag.withDescription(
        "Directory that receives <platform-key>/. Defaults to native/tailcat/dist.",
      ),
      Flag.optional,
    ),
    update: Flag.string("update").pipe(
      Flag.withDescription(
        "Re-pin the manifest to this upstream version: downloads the new release assets, records their digests, and prints what changed.",
      ),
      Flag.optional,
    ),
    buildFromSource: Flag.boolean("build-from-source").pipe(
      Flag.withDescription(
        "Compile from the pinned tag with Go instead of downloading a release archive. Always used for darwin, which has no upstream archives.",
      ),
    ),
    verbose: Flag.boolean("verbose").pipe(Flag.withDescription("Stream git and go output.")),
  },
  (flags) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* RepoRoot;
      const manifestPath = path.join(repoRoot, TAILCAT_MANIFEST_RELATIVE_PATH);

      if (Option.isSome(flags.update)) {
        return yield* updateManifestPin({
          repoRoot,
          manifestPath,
          requestedVersion: flags.update.value,
        });
      }

      const manifest = yield* readTailcatManifest(manifestPath);
      yield* Effect.log(
        `[fetch-tailcat] Manifest pins tailcat ${manifest.version} for ${tailcatManifestPlatformKeys(manifest).join(", ")}`,
      );
      if (flags.manifestOnly) {
        return;
      }

      const distRoot = Option.match(flags.out, {
        onNone: () => path.join(repoRoot, TAILCAT_DIST_RELATIVE_PATH),
        onSome: (out) => path.resolve(out),
      });
      const platformKeys = yield* selectPlatformKeys(manifest, flags);
      for (const platformKey of platformKeys) {
        if (flags.verify) {
          const provenance = yield* verifyTailcatDist({ distRoot, platformKey, manifest });
          yield* Effect.log(
            `[fetch-tailcat] ${platformKey}: OK (${provenance.version}, ${provenance.origin.kind}, sha256 ${provenance.sha256})`,
          );
          continue;
        }
        yield* fetchPlatform({
          manifest,
          platformKey,
          distRoot,
          buildFromSource: flags.buildFromSource,
          verbose: flags.verbose,
        });
      }
    }),
).pipe(
  Command.withDescription(
    "Fetch, build, verify, or re-pin the Tailcat CLI that T3 Code bundles (native/tailcat/manifest.json).",
  ),
);

if (import.meta.main) {
  Command.run(fetchTailcatCommand, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}

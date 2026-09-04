import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

/**
 * Pure helpers around `native/tailcat/manifest.json`, the single source of
 * truth for the pinned Tailcat release. `scripts/fetch-tailcat.ts` downloads,
 * builds, verifies, and rewrites through these; the desktop and CLI packaging
 * scripts read the manifest to check that a staged binary matches the pin.
 *
 * `packages/tailcat/src/manifest.ts` consumes the same JSON at runtime; the
 * platform-key vocabulary below mirrors it so a manifest that passes here also
 * satisfies the runtime resolver.
 */

export const TAILCAT_PLATFORM_KEYS = [
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
  "darwin-arm64",
  "darwin-x64",
] as const;
export const TailcatPlatformKey = Schema.Literals(TAILCAT_PLATFORM_KEYS);
export type TailcatPlatformKey = typeof TailcatPlatformKey.Type;

export const TAILCAT_MANIFEST_RELATIVE_PATH = "native/tailcat/manifest.json";
export const TAILCAT_LICENSE_RELATIVE_PATH = "native/tailcat/LICENSE";
export const TAILCAT_DIST_RELATIVE_PATH = "native/tailcat/dist";

export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const GitCommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
export const TailcatReleaseVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u));
const GoToolchainVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+(?:\.\d+)?$/u));

export const TailcatReleaseAsset = Schema.Struct({
  file: Schema.NonEmptyString,
  sha256: Sha256Hex,
  executable: Schema.NonEmptyString,
});

export const TailcatSourcePin = Schema.Struct({
  $comment: Schema.optionalKey(Schema.String),
  url: Schema.NonEmptyString,
  sha256: Sha256Hex,
  commit: GitCommitSha,
  goVersion: GoToolchainVersion,
  package: Schema.NonEmptyString,
  buildTagsFile: Schema.NonEmptyString,
  ldflags: Schema.String,
});

export const TailcatDarwinTarget = Schema.Struct({
  goarch: Schema.Literals(["arm64", "amd64"]),
  executable: Schema.NonEmptyString,
});

export const TailcatManifest = Schema.Struct({
  $comment: Schema.optionalKey(Schema.String),
  name: Schema.Literal("tailcat"),
  repository: Schema.NonEmptyString,
  license: Schema.NonEmptyString,
  version: TailcatReleaseVersion,
  releaseBaseUrl: Schema.NonEmptyString,
  assets: Schema.Record(Schema.String, TailcatReleaseAsset),
  source: TailcatSourcePin,
  darwinTargets: Schema.Record(Schema.String, TailcatDarwinTarget),
});
export type TailcatManifest = typeof TailcatManifest.Type;

export const decodeTailcatManifestJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(TailcatManifest),
);
export const encodeTailcatManifestJson = Schema.encodeEffect(fromJsonStringPretty(TailcatManifest));

export class TailcatManifestError extends Schema.TaggedErrorClass<TailcatManifestError>()(
  "TailcatManifestError",
  {
    manifestPath: Schema.String,
    problems: Schema.Array(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const problems = this.problems.map((problem) => `  - ${problem}`).join("\n");
    return `Tailcat manifest ${this.manifestPath} is invalid:\n${problems}`;
  }
}

export function tailcatExecutableName(platformKey: string): string {
  return platformKey.startsWith("win32-") ? "tailcat.exe" : "tailcat";
}

export function tailcatHostPlatformKey(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): TailcatPlatformKey | undefined {
  if (architecture !== "arm64" && architecture !== "x64") {
    return undefined;
  }
  switch (platform) {
    case "linux":
      return `linux-${architecture}`;
    case "win32":
      return `win32-${architecture}`;
    case "darwin":
      return `darwin-${architecture}`;
    default:
      return undefined;
  }
}

export interface GoTarget {
  readonly goos: "linux" | "windows" | "darwin";
  readonly goarch: "amd64" | "arm64";
}

const GO_TARGETS = {
  "linux-x64": { goos: "linux", goarch: "amd64" },
  "linux-arm64": { goos: "linux", goarch: "arm64" },
  "win32-x64": { goos: "windows", goarch: "amd64" },
  "win32-arm64": { goos: "windows", goarch: "arm64" },
  "darwin-arm64": { goos: "darwin", goarch: "arm64" },
  "darwin-x64": { goos: "darwin", goarch: "amd64" },
} as const satisfies Record<TailcatPlatformKey, GoTarget>;

export function goTargetForPlatformKey(platformKey: TailcatPlatformKey): GoTarget {
  return GO_TARGETS[platformKey];
}

export function isTailcatPlatformKey(value: string): value is TailcatPlatformKey {
  return (TAILCAT_PLATFORM_KEYS as ReadonlyArray<string>).includes(value);
}

/** Platform keys the manifest pins, in the canonical order. */
export function tailcatManifestPlatformKeys(
  manifest: TailcatManifest,
): ReadonlyArray<TailcatPlatformKey> {
  return TAILCAT_PLATFORM_KEYS.filter(
    (key) => key in manifest.assets || key in manifest.darwinTargets,
  );
}

export function tailcatReleaseAssetUrl(releaseBaseUrl: string, file: string): string {
  return `${releaseBaseUrl.replace(/\/+$/u, "")}/${file}`;
}

export type TailcatTarget =
  | {
      readonly kind: "release";
      readonly platformKey: TailcatPlatformKey;
      readonly executable: string;
      readonly file: string;
      readonly url: string;
      readonly sha256: string;
    }
  | {
      readonly kind: "source";
      readonly platformKey: TailcatPlatformKey;
      readonly executable: string;
      readonly goos: GoTarget["goos"];
      readonly goarch: GoTarget["goarch"];
    };

/** How the manifest says a platform's binary is obtained, or undefined when it is not pinned. */
export function resolveTailcatTarget(
  manifest: TailcatManifest,
  platformKey: TailcatPlatformKey,
): TailcatTarget | undefined {
  const asset = manifest.assets[platformKey];
  if (asset !== undefined) {
    return {
      kind: "release",
      platformKey,
      executable: asset.executable,
      file: asset.file,
      url: tailcatReleaseAssetUrl(manifest.releaseBaseUrl, asset.file),
      sha256: asset.sha256,
    };
  }
  const darwinTarget = manifest.darwinTargets[platformKey];
  if (darwinTarget !== undefined) {
    return {
      kind: "source",
      platformKey,
      executable: darwinTarget.executable,
      ...goTargetForPlatformKey(platformKey),
    };
  }
  return undefined;
}

/**
 * Consistency rules the schema alone cannot express: every runtime platform key
 * is pinned exactly once, and every version-bearing field agrees with `version`.
 */
export function validateTailcatManifest(manifest: TailcatManifest): ReadonlyArray<string> {
  const problems: string[] = [];
  const tag = `v${manifest.version}`;
  const pinned = new Set<string>();

  for (const [key, asset] of Object.entries(manifest.assets)) {
    pinned.add(key);
    if (!isTailcatPlatformKey(key)) {
      problems.push(`assets.${key}: unknown platform key`);
    }
    if (!asset.file.includes(manifest.version)) {
      problems.push(
        `assets.${key}.file: "${asset.file}" does not name version ${manifest.version}`,
      );
    }
    if (!/\.(?:tar\.gz|tgz|zip)$/u.test(asset.file)) {
      problems.push(`assets.${key}.file: "${asset.file}" is not a .tar.gz or .zip archive`);
    }
    const executable = tailcatExecutableName(key);
    if (asset.executable !== executable) {
      problems.push(
        `assets.${key}.executable: expected "${executable}", found "${asset.executable}"`,
      );
    }
  }

  for (const [key, target] of Object.entries(manifest.darwinTargets)) {
    if (pinned.has(key)) {
      problems.push(`${key}: pinned as both a release asset and a darwin source target`);
    }
    pinned.add(key);
    if (!isTailcatPlatformKey(key) || !key.startsWith("darwin-")) {
      problems.push(`darwinTargets.${key}: not a darwin platform key`);
      continue;
    }
    const expected = goTargetForPlatformKey(key);
    if (target.goarch !== expected.goarch) {
      problems.push(
        `darwinTargets.${key}.goarch: expected "${expected.goarch}", found "${target.goarch}"`,
      );
    }
    if (target.executable !== "tailcat") {
      problems.push(
        `darwinTargets.${key}.executable: expected "tailcat", found "${target.executable}"`,
      );
    }
  }

  for (const key of TAILCAT_PLATFORM_KEYS) {
    if (!pinned.has(key)) {
      problems.push(`${key}: no release asset or source target pinned`);
    }
  }

  if (!manifest.repository.startsWith("https://")) {
    problems.push(`repository: expected an https URL, found "${manifest.repository}"`);
  }
  if (!manifest.releaseBaseUrl.endsWith(`/${tag}`)) {
    problems.push(
      `releaseBaseUrl: expected to end with /${tag}, found "${manifest.releaseBaseUrl}"`,
    );
  }
  if (!manifest.source.url.includes(tag)) {
    problems.push(`source.url: does not reference ${tag}`);
  }
  if (!manifest.source.ldflags.includes(`main.version=${tag}`)) {
    problems.push(
      `source.ldflags: expected "-X main.version=${tag}", found "${manifest.source.ldflags}"`,
    );
  }

  return problems;
}

/** Reads and fully validates the manifest at `manifestPath`. */
export const readTailcatManifest = Effect.fn("readTailcatManifest")(function* (
  manifestPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(manifestPath);
  const manifest = yield* decodeTailcatManifestJson(raw).pipe(
    Effect.mapError(
      (cause) =>
        new TailcatManifestError({
          manifestPath,
          problems: ["does not match the manifest schema"],
          cause,
        }),
    ),
  );
  const problems = validateTailcatManifest(manifest);
  if (problems.length > 0) {
    return yield* new TailcatManifestError({ manifestPath, problems });
  }
  return manifest;
});

/** Parses a GoReleaser `checksums.txt` (`<sha256>  <file>` per line) into file -> digest. */
export function parseChecksumsFile(text: string): ReadonlyMap<string, string> {
  const digests = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/u.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      digests.set(match[2], match[1].toLowerCase());
    }
  }
  return digests;
}

/**
 * Resolves the commit a tag points at from `git ls-remote` output, preferring
 * the peeled `refs/tags/<tag>^{}` line so annotated tags resolve to the commit
 * rather than the tag object.
 */
export function parseGitLsRemoteCommit(output: string, tag: string): string | undefined {
  let tagObject: string | undefined;
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([0-9a-f]{40})\s+(\S+)$/u.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) continue;
    if (match[2] === `refs/tags/${tag}^{}`) {
      return match[1];
    }
    if (match[2] === `refs/tags/${tag}`) {
      tagObject = match[1];
    }
  }
  return tagObject;
}

/** The `go` directive of a go.mod, reduced to the major.minor toolchain line. */
export function parseGoModGoVersion(goMod: string): string | undefined {
  const match = /^go\s+(\d+\.\d+)(?:\.\d+)?\s*$/mu.exec(goMod);
  return match?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Replaces standalone occurrences of one version with another (`v0.5.0`, `tailcat_0.5.0_linux`). */
export function replaceTailcatVersion(value: string, from: string, to: string): string {
  return value.replace(new RegExp(`(^|[^\\d.])${escapeRegExp(from)}(?!\\d)`, "gu"), `$1${to}`);
}

export interface TailcatManifestUpdate {
  readonly version: string;
  /** Digest of each release archive at the new version, keyed by platform key. */
  readonly assetDigests: ReadonlyMap<string, string>;
  readonly source: {
    readonly sha256: string;
    readonly commit: string;
    readonly goVersion?: string | undefined;
  };
}

/**
 * Re-pins the manifest to a new version. Version-bearing strings are rewritten
 * in place so upstream naming conventions stay whatever the manifest already
 * encodes; digests come from the caller, which downloaded the new archives.
 */
export function updateTailcatManifest(
  manifest: TailcatManifest,
  update: TailcatManifestUpdate,
): Result.Result<TailcatManifest, string> {
  const rename = (value: string) => replaceTailcatVersion(value, manifest.version, update.version);
  const assets: Record<string, typeof TailcatReleaseAsset.Type> = {};
  for (const [key, asset] of Object.entries(manifest.assets)) {
    const sha256 = update.assetDigests.get(key);
    if (sha256 === undefined) {
      return Result.fail(`missing digest for ${key}`);
    }
    assets[key] = { file: rename(asset.file), sha256, executable: asset.executable };
  }
  return Result.succeed({
    ...manifest,
    version: update.version,
    releaseBaseUrl: rename(manifest.releaseBaseUrl),
    assets,
    source: {
      ...manifest.source,
      url: rename(manifest.source.url),
      sha256: update.source.sha256,
      commit: update.source.commit,
      goVersion: update.source.goVersion ?? manifest.source.goVersion,
      ldflags: rename(manifest.source.ldflags),
    },
  });
}

/** Human-readable `field: before -> after` lines for the fields that changed. */
export function summarizeTailcatManifestChanges(
  before: TailcatManifest,
  after: TailcatManifest,
): ReadonlyArray<string> {
  const changes: string[] = [];
  const compare = (field: string, previous: string, next: string) => {
    if (previous !== next) {
      changes.push(`${field}: ${previous} -> ${next}`);
    }
  };
  compare("version", before.version, after.version);
  compare("releaseBaseUrl", before.releaseBaseUrl, after.releaseBaseUrl);
  for (const key of new Set([...Object.keys(before.assets), ...Object.keys(after.assets)])) {
    const previous = before.assets[key];
    const next = after.assets[key];
    compare(`assets.${key}.file`, previous?.file ?? "(none)", next?.file ?? "(none)");
    compare(`assets.${key}.sha256`, previous?.sha256 ?? "(none)", next?.sha256 ?? "(none)");
  }
  compare("source.url", before.source.url, after.source.url);
  compare("source.sha256", before.source.sha256, after.source.sha256);
  compare("source.commit", before.source.commit, after.source.commit);
  compare("source.goVersion", before.source.goVersion, after.source.goVersion);
  compare("source.ldflags", before.source.ldflags, after.source.ldflags);
  return changes;
}

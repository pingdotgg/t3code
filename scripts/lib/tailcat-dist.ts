// @effect-diagnostics nodeBuiltinImport:off - binary digests use Node's crypto; every file access goes through the FileSystem service.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import {
  GitCommitSha,
  Sha256Hex,
  TailcatPlatformKey,
  resolveTailcatTarget,
  type TailcatManifest,
} from "./tailcat-manifest.ts";

/**
 * Layout of a staged Tailcat runtime directory, `<dist>/<platform-key>/`:
 *
 * - `tailcat[.exe]`      the executable the runtime resolver looks for
 * - `provenance.json`    where the executable came from and its digest
 * - `LICENSE.txt`        upstream BSD-3-Clause text, shipped next to the binary
 *
 * The provenance file is what makes a staged binary verifiable later: the
 * manifest pins archive digests, not binary digests, so the fetch step records
 * the archive (or source commit) it verified together with the digest of the
 * bytes it extracted. Companion files carry extensions on purpose: on macOS
 * osx-sign codesigns every extension-less file under Contents/, which is how
 * the executable gets signed and how a bare `LICENSE` would be fed to codesign.
 */

export const TAILCAT_PROVENANCE_FILE = "provenance.json";
export const TAILCAT_LICENSE_FILE = "LICENSE.txt";

export const TailcatProvenanceOrigin = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("release"),
    url: Schema.String,
    sha256: Sha256Hex,
  }),
  Schema.Struct({
    kind: Schema.Literal("source"),
    repository: Schema.String,
    tag: Schema.String,
    commit: GitCommitSha,
    goVersion: Schema.String,
    goos: Schema.String,
    goarch: Schema.String,
  }),
]);
export type TailcatProvenanceOrigin = typeof TailcatProvenanceOrigin.Type;

export const TailcatProvenance = Schema.Struct({
  name: Schema.Literal("tailcat"),
  version: Schema.String,
  platformKey: TailcatPlatformKey,
  executable: Schema.String,
  sha256: Sha256Hex,
  size: Schema.Int,
  origin: TailcatProvenanceOrigin,
  fetchedAt: Schema.String,
});
export type TailcatProvenance = typeof TailcatProvenance.Type;

const decodeProvenanceJson = Schema.decodeUnknownEffect(Schema.fromJsonString(TailcatProvenance));
const encodeProvenanceJson = Schema.encodeEffect(fromJsonStringPretty(TailcatProvenance));

export function sha256Hex(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

export function tailcatFetchCommand(platformKey: TailcatPlatformKey): string {
  return `node scripts/fetch-tailcat.ts --platform ${platformKey}`;
}

export const TailcatDistReason = Schema.Literals([
  "not-pinned",
  "binary-missing",
  "provenance-missing",
  "provenance-invalid",
  "version-mismatch",
  "origin-mismatch",
  "digest-mismatch",
]);
export type TailcatDistReason = typeof TailcatDistReason.Type;

const DIST_REASON_TEXT: Record<TailcatDistReason, string> = {
  "not-pinned": "is not pinned in native/tailcat/manifest.json",
  "binary-missing": "is not staged",
  "provenance-missing": "has no provenance.json",
  "provenance-invalid": "has an unreadable provenance.json",
  "version-mismatch": "was staged from a different pin",
  "origin-mismatch": "was staged from a different source than the manifest pins",
  "digest-mismatch": "does not match the digest recorded when it was fetched",
};

export class TailcatDistError extends Schema.TaggedErrorClass<TailcatDistError>()(
  "TailcatDistError",
  {
    platformKey: TailcatPlatformKey,
    directory: Schema.String,
    reason: TailcatDistReason,
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = this.detail === undefined ? "" : ` ${this.detail}.`;
    const hint =
      this.reason === "not-pinned"
        ? ""
        : ` Run \`${tailcatFetchCommand(this.platformKey)}\` to stage the pinned release.`;
    return `Tailcat runtime for ${this.platformKey} ${DIST_REASON_TEXT[this.reason]} (${this.directory}).${detail}${hint}`;
  }
}

/** Writes one platform's runtime directory, replacing whatever was there. */
export const writeTailcatDist = Effect.fn("writeTailcatDist")(function* (input: {
  readonly distRoot: string;
  readonly provenance: TailcatProvenance;
  readonly binary: Uint8Array;
  readonly license: Uint8Array | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(input.distRoot, input.provenance.platformKey);
  yield* fs.remove(directory, { recursive: true, force: true });
  yield* fs.makeDirectory(directory, { recursive: true });

  const binaryPath = path.join(directory, input.provenance.executable);
  yield* fs.writeFile(binaryPath, input.binary);
  if (!input.provenance.platformKey.startsWith("win32-")) {
    yield* fs.chmod(binaryPath, 0o755);
  }
  if (input.license !== undefined) {
    yield* fs.writeFile(path.join(directory, TAILCAT_LICENSE_FILE), input.license);
  }
  const provenanceJson = yield* encodeProvenanceJson(input.provenance);
  yield* fs.writeFileString(path.join(directory, TAILCAT_PROVENANCE_FILE), `${provenanceJson}\n`);

  return { directory, binaryPath };
});

/**
 * Proves a staged runtime still matches the manifest pin: the provenance names
 * the pinned version and the pinned archive digest (or source commit), and the
 * executable still hashes to the digest recorded at fetch time. A source-built
 * binary at the pinned commit is accepted for any platform, since that is the
 * documented fallback when an upstream archive is unavailable.
 */
export const verifyTailcatDist = Effect.fn("verifyTailcatDist")(function* (input: {
  readonly distRoot: string;
  readonly platformKey: TailcatPlatformKey;
  readonly manifest: TailcatManifest;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(input.distRoot, input.platformKey);
  const fail = (reason: TailcatDistReason, detail?: string) =>
    new TailcatDistError({
      platformKey: input.platformKey,
      directory,
      reason,
      ...(detail === undefined ? {} : { detail }),
    });

  const target = resolveTailcatTarget(input.manifest, input.platformKey);
  if (target === undefined) {
    return yield* fail("not-pinned");
  }

  const binaryPath = path.join(directory, target.executable);
  const binaryStat = yield* fs.stat(binaryPath).pipe(Effect.option);
  if (Option.isNone(binaryStat) || binaryStat.value.type !== "File") {
    return yield* fail("binary-missing");
  }

  const provenanceRaw = yield* fs
    .readFileString(path.join(directory, TAILCAT_PROVENANCE_FILE))
    .pipe(Effect.option);
  if (Option.isNone(provenanceRaw)) {
    return yield* fail("provenance-missing");
  }
  const provenance = yield* decodeProvenanceJson(provenanceRaw.value).pipe(
    Effect.mapError(
      (cause) =>
        new TailcatDistError({
          platformKey: input.platformKey,
          directory,
          reason: "provenance-invalid",
          cause,
        }),
    ),
  );

  if (
    provenance.version !== input.manifest.version ||
    provenance.platformKey !== input.platformKey ||
    provenance.executable !== target.executable
  ) {
    return yield* fail(
      "version-mismatch",
      `Staged: ${provenance.version} ${provenance.platformKey}; pinned: ${input.manifest.version} ${input.platformKey}`,
    );
  }

  const originMatches =
    provenance.origin.kind === "source"
      ? provenance.origin.commit === input.manifest.source.commit
      : target.kind === "release" &&
        provenance.origin.url === target.url &&
        provenance.origin.sha256 === target.sha256;
  if (!originMatches) {
    return yield* fail(
      "origin-mismatch",
      provenance.origin.kind === "source"
        ? `Staged from commit ${provenance.origin.commit}; pinned ${input.manifest.source.commit}`
        : `Staged from ${provenance.origin.url} (${provenance.origin.sha256})`,
    );
  }

  const digest = sha256Hex(yield* fs.readFile(binaryPath));
  if (digest !== provenance.sha256) {
    return yield* fail("digest-mismatch", `Expected ${provenance.sha256}, found ${digest}`);
  }

  return provenance;
});

/** Verifies a staged runtime, then copies its directory to `<destinationRoot>/<platform-key>/`. */
export const stageTailcatDist = Effect.fn("stageTailcatDist")(function* (input: {
  readonly distRoot: string;
  readonly platformKey: TailcatPlatformKey;
  readonly manifest: TailcatManifest;
  readonly destinationRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const provenance = yield* verifyTailcatDist(input);
  const source = path.join(input.distRoot, input.platformKey);
  const destination = path.join(input.destinationRoot, input.platformKey);
  yield* fs.remove(destination, { recursive: true, force: true });
  yield* fs.makeDirectory(input.destinationRoot, { recursive: true });
  yield* fs.copy(source, destination);
  if (!input.platformKey.startsWith("win32-")) {
    yield* fs.chmod(path.join(destination, provenance.executable), 0o755);
  }
  return provenance;
});

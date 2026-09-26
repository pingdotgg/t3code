import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  TAILCAT_LICENSE_FILE,
  TAILCAT_PROVENANCE_FILE,
  TailcatDistError,
  sha256Hex,
  stageTailcatDist,
  verifyTailcatDist,
  writeTailcatDist,
  type TailcatProvenance,
} from "./tailcat-dist.ts";
import type { TailcatManifest } from "./tailcat-manifest.ts";

const digest = (fill: string) => fill.repeat(64);
const encoder = new TextEncoder();

const manifest: TailcatManifest = {
  name: "tailcat",
  repository: "https://github.com/tailscale/tailcat",
  license: "BSD-3-Clause",
  version: "0.5.0",
  releaseBaseUrl: "https://github.com/tailscale/tailcat/releases/download/v0.5.0",
  assets: {
    "linux-x64": {
      file: "tailcat_0.5.0_linux_amd64.tar.gz",
      sha256: digest("1"),
      executable: "tailcat",
    },
    "win32-x64": {
      file: "tailcat_0.5.0_windows_amd64.zip",
      sha256: digest("3"),
      executable: "tailcat.exe",
    },
  },
  source: {
    url: "https://github.com/tailscale/tailcat/archive/refs/tags/v0.5.0.tar.gz",
    sha256: digest("5"),
    commit: "c".repeat(40),
    goVersion: "1.27",
    package: "./cmd/tailcat",
    buildTagsFile: "build-tags.txt",
    ldflags: "-s -w -X main.version=v0.5.0",
  },
  darwinTargets: {
    "darwin-arm64": { goarch: "arm64", executable: "tailcat" },
  },
};

const binary = encoder.encode("#!/bin/sh\necho tailcat\n");

const releaseProvenance: TailcatProvenance = {
  name: "tailcat",
  version: "0.5.0",
  platformKey: "linux-x64",
  executable: "tailcat",
  sha256: sha256Hex(binary),
  size: binary.length,
  origin: {
    kind: "release",
    url: "https://github.com/tailscale/tailcat/releases/download/v0.5.0/tailcat_0.5.0_linux_amd64.tar.gz",
    sha256: digest("1"),
  },
  fetchedAt: "2026-09-03T00:00:00.000Z",
};

const sourceProvenance = (platformKey: TailcatProvenance["platformKey"]): TailcatProvenance => ({
  ...releaseProvenance,
  platformKey,
  origin: {
    kind: "source",
    repository: manifest.repository,
    tag: "v0.5.0",
    commit: manifest.source.commit,
    goVersion: "go version go1.27.1 linux/amd64",
    goos: "darwin",
    goarch: "arm64",
  },
});

const withTempDist = <A, E>(
  body: (distRoot: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const distRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tailcat-dist-" });
    return yield* body(distRoot);
  });

it.layer(NodeServices.layer)("tailcat-dist", (it) => {
  it("hashes bytes as lowercase hex", () => {
    assert.equal(
      sha256Hex(encoder.encode("abc")),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it.effect("writes an executable runtime directory that verifies against the manifest", () =>
    withTempDist((distRoot) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const written = yield* writeTailcatDist({
          distRoot,
          provenance: releaseProvenance,
          binary,
          license: encoder.encode("BSD 3-Clause License\n"),
        });

        assert.equal(written.directory, path.join(distRoot, "linux-x64"));
        const stat = yield* fs.stat(written.binaryPath);
        assert.equal(stat.type, "File");
        assert.equal(stat.mode & 0o111, 0o111);
        assert.isTrue(yield* fs.exists(path.join(written.directory, TAILCAT_LICENSE_FILE)));
        assert.isTrue(yield* fs.exists(path.join(written.directory, TAILCAT_PROVENANCE_FILE)));

        const verified = yield* verifyTailcatDist({ distRoot, platformKey: "linux-x64", manifest });
        assert.deepStrictEqual(verified, releaseProvenance);
      }),
    ),
  );

  it.effect("accepts a source build at the pinned commit for any platform", () =>
    withTempDist((distRoot) =>
      Effect.gen(function* () {
        yield* writeTailcatDist({
          distRoot,
          provenance: sourceProvenance("linux-x64"),
          binary,
          license: undefined,
        });
        yield* writeTailcatDist({
          distRoot,
          provenance: sourceProvenance("darwin-arm64"),
          binary,
          license: undefined,
        });

        const linux = yield* verifyTailcatDist({ distRoot, platformKey: "linux-x64", manifest });
        assert.equal(linux.origin.kind, "source");
        const darwin = yield* verifyTailcatDist({
          distRoot,
          platformKey: "darwin-arm64",
          manifest,
        });
        assert.equal(darwin.platformKey, "darwin-arm64");

        const otherCommit = yield* verifyTailcatDist({
          distRoot,
          platformKey: "darwin-arm64",
          manifest: { ...manifest, source: { ...manifest.source, commit: "d".repeat(40) } },
        }).pipe(Effect.flip);
        assert.instanceOf(otherCommit, TailcatDistError);
        assert.equal(otherCommit.reason, "origin-mismatch");
      }),
    ),
  );

  it.effect("rejects missing, stale, re-pinned, and tampered runtimes", () =>
    withTempDist((distRoot) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const reasonFor = (input: {
          readonly platformKey: TailcatProvenance["platformKey"];
          readonly manifest?: TailcatManifest;
        }) =>
          verifyTailcatDist({
            distRoot,
            platformKey: input.platformKey,
            manifest: input.manifest ?? manifest,
          }).pipe(
            Effect.flip,
            Effect.map((error) => {
              assert.instanceOf(error, TailcatDistError);
              return error.reason;
            }),
          );

        assert.equal(yield* reasonFor({ platformKey: "linux-x64" }), "binary-missing");
        assert.equal(yield* reasonFor({ platformKey: "win32-arm64" }), "not-pinned");

        const written = yield* writeTailcatDist({
          distRoot,
          provenance: releaseProvenance,
          binary,
          license: undefined,
        });
        assert.equal(
          yield* reasonFor({
            platformKey: "linux-x64",
            manifest: { ...manifest, version: "0.6.0" },
          }),
          "version-mismatch",
        );
        assert.equal(
          yield* reasonFor({
            platformKey: "linux-x64",
            manifest: {
              ...manifest,
              assets: {
                ...manifest.assets,
                "linux-x64": { ...manifest.assets["linux-x64"]!, sha256: digest("f") },
              },
            },
          }),
          "origin-mismatch",
        );

        yield* fs.writeFile(written.binaryPath, encoder.encode("tampered"));
        assert.equal(yield* reasonFor({ platformKey: "linux-x64" }), "digest-mismatch");

        yield* fs.writeFileString(path.join(written.directory, TAILCAT_PROVENANCE_FILE), "{}");
        assert.equal(yield* reasonFor({ platformKey: "linux-x64" }), "provenance-invalid");

        yield* fs.remove(path.join(written.directory, TAILCAT_PROVENANCE_FILE));
        assert.equal(yield* reasonFor({ platformKey: "linux-x64" }), "provenance-missing");
        const missing = yield* verifyTailcatDist({
          distRoot,
          platformKey: "linux-x64",
          manifest,
        }).pipe(Effect.flip);
        assert.include(missing.message, "node scripts/fetch-tailcat.ts --platform linux-x64");
      }),
    ),
  );

  it.effect("stages a verified runtime into another root and keeps it executable", () =>
    withTempDist((distRoot) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTailcatDist({
          distRoot,
          provenance: releaseProvenance,
          binary,
          license: encoder.encode("BSD 3-Clause License\n"),
        });
        const destinationRoot = path.join(distRoot, "staged", "tailcat");
        yield* fs.makeDirectory(path.join(destinationRoot, "linux-x64"), { recursive: true });
        yield* fs.writeFileString(path.join(destinationRoot, "linux-x64", "stale.txt"), "stale");

        const provenance = yield* stageTailcatDist({
          distRoot,
          platformKey: "linux-x64",
          manifest,
          destinationRoot,
        });
        assert.equal(provenance.sha256, releaseProvenance.sha256);

        const stagedBinary = path.join(destinationRoot, "linux-x64", "tailcat");
        assert.deepStrictEqual(yield* fs.readFile(stagedBinary), binary);
        assert.equal((yield* fs.stat(stagedBinary)).mode & 0o111, 0o111);
        assert.isTrue(
          yield* fs.exists(path.join(destinationRoot, "linux-x64", TAILCAT_PROVENANCE_FILE)),
        );
        assert.isTrue(
          yield* fs.exists(path.join(destinationRoot, "linux-x64", TAILCAT_LICENSE_FILE)),
        );
        assert.isFalse(yield* fs.exists(path.join(destinationRoot, "linux-x64", "stale.txt")));

        const unstaged = yield* stageTailcatDist({
          distRoot,
          platformKey: "win32-x64",
          manifest,
          destinationRoot,
        }).pipe(Effect.flip);
        assert.instanceOf(unstaged, TailcatDistError);
        assert.equal(unstaged.reason, "binary-missing");
      }),
    ),
  );
});

import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import {
  TAILCAT_PLATFORM_KEYS,
  TailcatManifestError,
  encodeTailcatManifestJson,
  goTargetForPlatformKey,
  parseChecksumsFile,
  parseGitLsRemoteCommit,
  parseGoModGoVersion,
  readTailcatManifest,
  replaceTailcatVersion,
  resolveTailcatTarget,
  summarizeTailcatManifestChanges,
  tailcatExecutableName,
  tailcatHostPlatformKey,
  tailcatManifestPlatformKeys,
  tailcatReleaseAssetUrl,
  updateTailcatManifest,
  validateTailcatManifest,
  type TailcatManifest,
} from "./tailcat-manifest.ts";

const committedManifestPath = NodeURL.fileURLToPath(
  new URL("../../native/tailcat/manifest.json", import.meta.url),
);

const digest = (fill: string) => fill.repeat(64);

const fixture: TailcatManifest = {
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
    "linux-arm64": {
      file: "tailcat_0.5.0_linux_arm64.tar.gz",
      sha256: digest("2"),
      executable: "tailcat",
    },
    "win32-x64": {
      file: "tailcat_0.5.0_windows_amd64.zip",
      sha256: digest("3"),
      executable: "tailcat.exe",
    },
    "win32-arm64": {
      file: "tailcat_0.5.0_windows_arm64.zip",
      sha256: digest("4"),
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
    "darwin-x64": { goarch: "amd64", executable: "tailcat" },
  },
};

describe("tailcat-manifest", () => {
  it("maps hosts to platform keys, executables, and Go targets", () => {
    assert.equal(tailcatHostPlatformKey("linux", "x64"), "linux-x64");
    assert.equal(tailcatHostPlatformKey("darwin", "arm64"), "darwin-arm64");
    assert.equal(tailcatHostPlatformKey("win32", "arm64"), "win32-arm64");
    assert.isUndefined(tailcatHostPlatformKey("freebsd", "x64"));
    assert.isUndefined(tailcatHostPlatformKey("linux", "ia32"));

    assert.equal(tailcatExecutableName("win32-x64"), "tailcat.exe");
    assert.equal(tailcatExecutableName("linux-arm64"), "tailcat");

    assert.deepStrictEqual(goTargetForPlatformKey("linux-x64"), { goos: "linux", goarch: "amd64" });
    assert.deepStrictEqual(goTargetForPlatformKey("win32-arm64"), {
      goos: "windows",
      goarch: "arm64",
    });
    assert.deepStrictEqual(goTargetForPlatformKey("darwin-x64"), {
      goos: "darwin",
      goarch: "amd64",
    });
  });

  it("resolves each pinned platform to a release archive or a source build", () => {
    assert.deepStrictEqual(tailcatManifestPlatformKeys(fixture), [...TAILCAT_PLATFORM_KEYS]);
    assert.equal(
      tailcatReleaseAssetUrl("https://example.test/releases/v0.5.0/", "tailcat.tar.gz"),
      "https://example.test/releases/v0.5.0/tailcat.tar.gz",
    );

    assert.deepStrictEqual(resolveTailcatTarget(fixture, "win32-x64"), {
      kind: "release",
      platformKey: "win32-x64",
      executable: "tailcat.exe",
      file: "tailcat_0.5.0_windows_amd64.zip",
      url: "https://github.com/tailscale/tailcat/releases/download/v0.5.0/tailcat_0.5.0_windows_amd64.zip",
      sha256: digest("3"),
    });
    assert.deepStrictEqual(resolveTailcatTarget(fixture, "darwin-arm64"), {
      kind: "source",
      platformKey: "darwin-arm64",
      executable: "tailcat",
      goos: "darwin",
      goarch: "arm64",
    });

    const { "linux-arm64": _dropped, ...assets } = fixture.assets;
    assert.isUndefined(resolveTailcatTarget({ ...fixture, assets }, "linux-arm64"));
  });

  it("accepts a consistent manifest and names every inconsistency", () => {
    assert.deepStrictEqual(validateTailcatManifest(fixture), []);

    const { "linux-arm64": _dropped, ...assets } = fixture.assets;
    const problems = validateTailcatManifest({
      ...fixture,
      releaseBaseUrl: "https://github.com/tailscale/tailcat/releases/download/v0.4.0",
      assets: {
        ...assets,
        "win32-x64": { ...fixture.assets["win32-x64"]!, executable: "tailcat" },
        "freebsd-x64": {
          file: "tailcat_0.5.0_freebsd_amd64.tar.gz",
          sha256: digest("9"),
          executable: "tailcat",
        },
      },
      source: { ...fixture.source, ldflags: "-s -w -X main.version=v0.4.0" },
      darwinTargets: {
        ...fixture.darwinTargets,
        "darwin-arm64": { goarch: "amd64", executable: "tailcat" },
      },
    });

    assert.include(problems, "linux-arm64: no release asset or source target pinned");
    assert.include(problems, "assets.freebsd-x64: unknown platform key");
    assert.include(
      problems,
      'assets.win32-x64.executable: expected "tailcat.exe", found "tailcat"',
    );
    assert.include(problems, 'darwinTargets.darwin-arm64.goarch: expected "arm64", found "amd64"');
    assert.include(
      problems,
      'releaseBaseUrl: expected to end with /v0.5.0, found "https://github.com/tailscale/tailcat/releases/download/v0.4.0"',
    );
    assert.include(
      problems,
      'source.ldflags: expected "-X main.version=v0.5.0", found "-s -w -X main.version=v0.4.0"',
    );
  });

  it("parses upstream checksums, ls-remote output, and go.mod", () => {
    const checksums = parseChecksumsFile(
      [
        `${digest("a")}  tailcat_0.5.0_linux_amd64.tar.gz`,
        `${digest("B")} *tailcat_0.5.0_windows_amd64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    assert.equal(checksums.get("tailcat_0.5.0_linux_amd64.tar.gz"), digest("a"));
    assert.equal(checksums.get("tailcat_0.5.0_windows_amd64.zip"), digest("b"));
    assert.equal(checksums.size, 2);

    const lsRemote = [
      `${"d".repeat(40)}\trefs/tags/v0.5.0`,
      `${"c".repeat(40)}\trefs/tags/v0.5.0^{}`,
      `${"e".repeat(40)}\trefs/tags/v0.5.0-rc.1`,
    ].join("\n");
    assert.equal(parseGitLsRemoteCommit(lsRemote, "v0.5.0"), "c".repeat(40));
    assert.equal(
      parseGitLsRemoteCommit(`${"f".repeat(40)}\trefs/tags/v0.6.0\n`, "v0.6.0"),
      "f".repeat(40),
    );
    assert.isUndefined(parseGitLsRemoteCommit(lsRemote, "v0.7.0"));

    assert.equal(
      parseGoModGoVersion("module example.com/x\n\ngo 1.27.0\n\nrequire (\n)\n"),
      "1.27",
    );
    assert.equal(parseGoModGoVersion("go 1.26\n"), "1.26");
    assert.isUndefined(parseGoModGoVersion("module example.com/x\n"));
  });

  it("replaces standalone version strings only", () => {
    assert.equal(
      replaceTailcatVersion("tailcat_0.5.0_linux_amd64.tar.gz", "0.5.0", "0.6.0"),
      "tailcat_0.6.0_linux_amd64.tar.gz",
    );
    assert.equal(
      replaceTailcatVersion("https://x/download/v0.5.0", "0.5.0", "0.6.0"),
      "https://x/download/v0.6.0",
    );
    assert.equal(
      replaceTailcatVersion("archive/refs/tags/v0.5.0.tar.gz", "0.5.0", "1.0.0"),
      "archive/refs/tags/v1.0.0.tar.gz",
    );
    assert.equal(
      replaceTailcatVersion("v10.5.0 and 0.5.01", "0.5.0", "0.6.0"),
      "v10.5.0 and 0.5.01",
    );
  });

  it("re-pins the manifest and summarizes what changed", () => {
    const assetDigests = new Map<string, string>([
      ["linux-x64", digest("6")],
      ["linux-arm64", digest("7")],
      ["win32-x64", digest("8")],
      ["win32-arm64", digest("9")],
    ]);
    const updated = updateTailcatManifest(fixture, {
      version: "0.6.0",
      assetDigests,
      source: { sha256: digest("a"), commit: "b".repeat(40), goVersion: "1.28" },
    });
    assert.isTrue(Result.isSuccess(updated));
    if (!Result.isSuccess(updated)) return;

    assert.deepStrictEqual(validateTailcatManifest(updated.success), []);
    assert.equal(updated.success.version, "0.6.0");
    assert.equal(
      updated.success.releaseBaseUrl,
      "https://github.com/tailscale/tailcat/releases/download/v0.6.0",
    );
    assert.equal(updated.success.assets["win32-arm64"]?.file, "tailcat_0.6.0_windows_arm64.zip");
    assert.equal(updated.success.assets["win32-arm64"]?.sha256, digest("9"));
    assert.equal(
      updated.success.source.url,
      "https://github.com/tailscale/tailcat/archive/refs/tags/v0.6.0.tar.gz",
    );
    assert.equal(updated.success.source.ldflags, "-s -w -X main.version=v0.6.0");
    assert.equal(updated.success.source.commit, "b".repeat(40));
    assert.equal(updated.success.source.goVersion, "1.28");
    assert.deepStrictEqual(updated.success.darwinTargets, fixture.darwinTargets);

    const changes = summarizeTailcatManifestChanges(fixture, updated.success);
    assert.include(changes, "version: 0.5.0 -> 0.6.0");
    assert.include(changes, `assets.linux-x64.sha256: ${digest("1")} -> ${digest("6")}`);
    assert.include(changes, `source.commit: ${"c".repeat(40)} -> ${"b".repeat(40)}`);
    assert.include(changes, "source.goVersion: 1.27 -> 1.28");
    assert.deepStrictEqual(summarizeTailcatManifestChanges(fixture, fixture), []);

    assetDigests.delete("win32-x64");
    const incomplete = updateTailcatManifest(fixture, {
      version: "0.6.0",
      assetDigests,
      source: { sha256: digest("a"), commit: "b".repeat(40) },
    });
    assert.isTrue(Result.isFailure(incomplete));
    if (Result.isFailure(incomplete)) {
      assert.equal(incomplete.failure, "missing digest for win32-x64");
    }
  });

  it.effect("validates the committed manifest and round-trips it through the encoder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const manifest = yield* readTailcatManifest(committedManifestPath);
      assert.deepStrictEqual(tailcatManifestPlatformKeys(manifest), [...TAILCAT_PLATFORM_KEYS]);
      const encoded = yield* encodeTailcatManifestJson(manifest);
      assert.equal(`${encoded}\n`, yield* fs.readFileString(committedManifestPath));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a manifest that decodes but is inconsistent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tailcat-manifest-" });
      const manifestPath = path.join(directory, "manifest.json");
      const { "darwin-x64": _dropped, ...darwinTargets } = fixture.darwinTargets;
      yield* fs.writeFileString(
        manifestPath,
        yield* encodeTailcatManifestJson({ ...fixture, darwinTargets }),
      );

      const error = yield* readTailcatManifest(manifestPath).pipe(Effect.flip);
      assert.instanceOf(error, TailcatManifestError);
      assert.deepStrictEqual(error.problems, [
        "darwin-x64: no release asset or source target pinned",
      ]);

      yield* fs.writeFileString(manifestPath, '{"name":"tailcat"}');
      const schemaError = yield* readTailcatManifest(manifestPath).pipe(Effect.flip);
      assert.instanceOf(schemaError, TailcatManifestError);
      assert.deepStrictEqual(schemaError.problems, ["does not match the manifest schema"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

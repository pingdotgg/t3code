import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command, CliError } from "effect/unstable/cli";

import {
  mergePlatformUpdateManifests,
  mergeUpdateManifestsCommand,
  parsePlatformUpdateManifest,
  serializePlatformUpdateManifest,
} from "./merge-update-manifests.ts";

const runCli = Command.runWith(mergeUpdateManifestsCommand, { version: "0.0.0" });

describe("merge-update-manifests", () => {
  it("merges arm64 and x64 macOS update manifests into one multi-arch manifest", () => {
    const arm64 = parsePlatformUpdateManifest(
      "mac",
      `version: 0.0.4
files:
  - url: T3-Code-0.0.4-arm64.zip
    sha512: arm64zip
    size: 125621344
  - url: T3-Code-0.0.4-arm64.dmg
    sha512: arm64dmg
    size: 131754935
path: T3-Code-0.0.4-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-07T10:32:14.587Z'
`,
      "latest-mac.yml",
    );

    const x64 = parsePlatformUpdateManifest(
      "mac",
      `version: 0.0.4
files:
  - url: T3-Code-0.0.4-x64.zip
    sha512: x64zip
    size: 132000112
  - url: T3-Code-0.0.4-x64.dmg
    sha512: x64dmg
    size: 138148807
path: T3-Code-0.0.4-x64.zip
sha512: x64zip
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-mac-x64.yml",
    );

    const merged = mergePlatformUpdateManifests("mac", arm64, x64);

    assert.equal(merged.version, "0.0.4");
    assert.equal(merged.releaseDate, "2026-03-07T10:36:07.540Z");
    assert.deepStrictEqual(
      merged.files.map((file) => file.url),
      [
        "T3-Code-0.0.4-arm64.zip",
        "T3-Code-0.0.4-arm64.dmg",
        "T3-Code-0.0.4-x64.zip",
        "T3-Code-0.0.4-x64.dmg",
      ],
    );

    const serialized = serializePlatformUpdateManifest("mac", merged);
    assert.ok(!serialized.includes("path:"));
    assert.equal((serialized.match(/- url:/g) ?? []).length, 4);
  });

  it("merges arm64 and x64 Windows update manifests into one multi-arch manifest", () => {
    const arm64 = parsePlatformUpdateManifest(
      "win",
      `version: 0.0.4
files:
  - url: T3-Code-0.0.4-arm64.exe
    sha512: arm64exe
    size: 125621344
  - url: T3-Code-0.0.4-arm64.exe.blockmap
    sha512: arm64blockmap
    size: 131754
path: T3-Code-0.0.4-arm64.exe
sha512: arm64exe
releaseDate: '2026-03-07T10:32:14.587Z'
`,
      "latest-win-arm64.yml",
    );

    const x64 = parsePlatformUpdateManifest(
      "win",
      `version: 0.0.4
files:
  - url: T3-Code-0.0.4-x64.exe
    sha512: x64exe
    size: 132000112
  - url: T3-Code-0.0.4-x64.exe.blockmap
    sha512: x64blockmap
    size: 138148
path: T3-Code-0.0.4-x64.exe
sha512: x64exe
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-win-x64.yml",
    );

    const merged = mergePlatformUpdateManifests("win", arm64, x64);

    assert.equal(merged.version, "0.0.4");
    assert.equal(merged.releaseDate, "2026-03-07T10:36:07.540Z");
    assert.deepStrictEqual(
      merged.files.map((file) => file.url),
      [
        "T3-Code-0.0.4-arm64.exe",
        "T3-Code-0.0.4-arm64.exe.blockmap",
        "T3-Code-0.0.4-x64.exe",
        "T3-Code-0.0.4-x64.exe.blockmap",
      ],
    );

    const serialized = serializePlatformUpdateManifest("win", merged);
    assert.ok(!serialized.includes("path:"));
    assert.equal((serialized.match(/- url:/g) ?? []).length, 4);
  });

  it("rejects mismatched manifest versions", () => {
    const primary = parsePlatformUpdateManifest(
      "win",
      `version: 0.0.4
files:
  - url: T3-Code-0.0.4-arm64.exe
    sha512: arm64exe
    size: 1
releaseDate: '2026-03-07T10:32:14.587Z'
`,
      "latest-win-arm64.yml",
    );

    const secondary = parsePlatformUpdateManifest(
      "win",
      `version: 0.0.5
files:
  - url: T3-Code-0.0.5-x64.exe
    sha512: x64exe
    size: 1
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-win-x64.yml",
    );

    assert.throws(
      () => mergePlatformUpdateManifests("win", primary, secondary),
      /different versions/,
    );
  });

  it("preserves quoted scalars as strings", () => {
    const manifest = parsePlatformUpdateManifest(
      "mac",
      `version: '1.0'
files:
  - url: T3-Code-1.0-x64.zip
    sha512: zipsha
    size: 1
releaseName: 'true'
minimumSystemVersion: '13.0'
stagingPercentage: 50
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-mac.yml",
    );

    assert.equal(manifest.version, "1.0");
    assert.equal(manifest.extras.releaseName, "true");
    assert.equal(manifest.extras.minimumSystemVersion, "13.0");
    assert.equal(manifest.extras.stagingPercentage, 50);
  });

  it("round-trips numeric-looking versions as strings", () => {
    const original = parsePlatformUpdateManifest(
      "win",
      `version: '1.0'
files:
  - url: T3-Code-1.0-x64.exe
    sha512: exesha
    size: 1
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-win-x64.yml",
    );

    const serialized = serializePlatformUpdateManifest("win", original);
    assert.ok(serialized.includes("version: '1.0'"));

    const reparsed = parsePlatformUpdateManifest("win", serialized, "latest-win-x64.yml");
    assert.equal(reparsed.version, "1.0");
  });
});

it.layer(NodeServices.layer)("merge-update-manifests cli", (it) => {
  const arm64MacManifest = `version: 0.0.4
files:
  - url: T3-Code-0.0.4-arm64.zip
    sha512: arm64zip
    size: 125621344
  - url: T3-Code-0.0.4-arm64.dmg
    sha512: arm64dmg
    size: 131754935
path: T3-Code-0.0.4-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-07T10:32:14.587Z'
`;

  const x64MacManifest = `version: 0.0.4
files:
  - url: T3-Code-0.0.4-x64.zip
    sha512: x64zip
    size: 132000112
  - url: T3-Code-0.0.4-x64.dmg
    sha512: x64dmg
    size: 138148807
path: T3-Code-0.0.4-x64.zip
sha512: x64zip
releaseDate: '2026-03-07T10:36:07.540Z'
`;

  it.effect("writes the merged manifest back to the primary path by default", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "merge-update-manifests-cli-",
      });
      const primaryPath = path.join(baseDir, "latest-mac.yml");
      const secondaryPath = path.join(baseDir, "latest-mac-x64.yml");

      yield* fs.writeFileString(primaryPath, arm64MacManifest);
      yield* fs.writeFileString(secondaryPath, x64MacManifest);

      yield* runCli(["--platform", "mac", primaryPath, secondaryPath]);

      const merged = yield* fs.readFileString(primaryPath);
      assert.ok(merged.includes("T3-Code-0.0.4-arm64.zip"));
      assert.ok(merged.includes("T3-Code-0.0.4-x64.zip"));
      assert.ok(!merged.includes("path:"));
    }),
  );

  it.effect("writes the merged manifest to an explicit output path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "merge-update-manifests-cli-output-",
      });
      const primaryPath = path.join(baseDir, "latest-win-arm64.yml");
      const secondaryPath = path.join(baseDir, "latest-win-x64.yml");
      const outputPath = path.join(baseDir, "latest-win.yml");

      yield* fs.writeFileString(
        primaryPath,
        `version: 0.0.4
files:
  - url: T3-Code-0.0.4-arm64.exe
    sha512: arm64exe
    size: 125621344
releaseDate: '2026-03-07T10:32:14.587Z'
`,
      );
      yield* fs.writeFileString(
        secondaryPath,
        `version: 0.0.4
files:
  - url: T3-Code-0.0.4-x64.exe
    sha512: x64exe
    size: 132000112
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      );

      yield* runCli(["--platform", "win", primaryPath, secondaryPath, outputPath]);

      const merged = yield* fs.readFileString(outputPath);
      assert.ok(merged.includes("T3-Code-0.0.4-arm64.exe"));
      assert.ok(merged.includes("T3-Code-0.0.4-x64.exe"));
    }),
  );

  it.effect("rejects invalid platform values during cli parsing", () =>
    Effect.gen(function* () {
      const error = yield* runCli(["--platform", "linux", "a.yml", "b.yml"]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }

      const platformError =
        error._tag === "ShowHelp" ? (error.errors[0] as CliError.CliError | undefined) : error;

      if (!platformError || platformError._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${String(platformError?._tag)}`);
      }

      assert.equal(platformError.option, "platform");
      assert.equal(platformError.value, "linux");
    }),
  );
});

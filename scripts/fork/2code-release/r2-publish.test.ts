import { assert, describe, it } from "@effect/vitest";

import { parseReleaseConfig } from "./release-core.ts";
import {
  immutableManifestPath,
  publicObjectUrl,
  releaseObjectKey,
  rollbackObjectPath,
} from "./r2-publish.ts";

const config = parseReleaseConfig({
  schemaVersion: 1,
  version: "1.0.108",
  distribution: "2code-production",
  releaseBranch: "main-2code",
  githubRepository: "hafencity-dev/t3code",
  githubTagPrefix: "2code-v",
  appId: "dev.hafencity.dev.agents",
  productName: "2code",
  executableName: "2code",
  architecture: "arm64",
  teamId: "D78YC33UVC",
  feedUrl: "https://updates.example.com/releases/desktop",
  r2Bucket: "2code",
  r2Prefix: "releases/desktop",
  manifestName: "latest-mac.yml",
  betaManifestName: "beta-mac.yml",
  updaterCacheDirName: "2code-updater",
  protocolSchemes: ["twentyfirst-agents"],
  stagingPercentage: 100,
  minimumLegacyVersion: "1.0.107",
});

describe("2code R2 publishing", () => {
  it("keeps every immutable object below the existing feed prefix", () => {
    assert.equal(
      releaseObjectKey(config, "objects/abc/2code-1.0.108-arm64-mac.zip"),
      "releases/desktop/objects/abc/2code-1.0.108-arm64-mac.zip",
    );
    assert.equal(
      publicObjectUrl(config, "objects/abc/2code-1.0.108-arm64-mac.zip"),
      "https://updates.example.com/releases/desktop/objects/abc/2code-1.0.108-arm64-mac.zip",
    );
    assert.throws(() => releaseObjectKey(config, "../latest-mac.yml"), /Unsafe/);
  });

  it("content-addresses manifests and rollback snapshots", () => {
    const candidate = immutableManifestPath("1.0.108", "new manifest");
    const rollback = rollbackObjectPath({
      releaseVersion: "1.0.108",
      previousVersion: "1.0.107",
      previousManifest: "old manifest",
    });
    assert.match(candidate, /^manifests\/1\.0\.108\/[a-f0-9]{128}\.yml$/);
    assert.match(rollback, /^rollbacks\/1\.0\.108\/from-1\.0\.107-[a-f0-9]{128}\.yml$/);
  });
});

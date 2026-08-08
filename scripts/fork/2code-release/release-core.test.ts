// @effect-diagnostics nodeBuiltinImport:off - Tests create isolated release artifact fixtures.

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";

import {
  compareStableVersions,
  decideRelease,
  decideReleaseAcrossChannels,
  expectedArtifactNames,
  manifestStagingPercentage,
  parseReleaseConfig,
  prepareReleaseArtifacts,
  readManifest,
  serializeManifestWithRollout,
  verifyPreparedArtifacts,
} from "./release-core.ts";

const validConfig = {
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
  stagingPercentage: 25,
  minimumLegacyVersion: "1.0.107",
} as const;

function sha512(value: string): string {
  return NodeCrypto.createHash("sha512").update(value).digest("base64");
}

describe("2code release core", () => {
  it("validates the frozen legacy identity contract", () => {
    const config = parseReleaseConfig(validConfig);
    assert.equal(config.appId, "dev.hafencity.dev.agents");
    assert.equal(config.teamId, "D78YC33UVC");
    assert.deepStrictEqual(expectedArtifactNames(config), [
      "2code-1.0.108-arm64-mac.zip",
      "2code-1.0.108-arm64.dmg",
    ]);

    assert.throws(
      () => parseReleaseConfig({ ...validConfig, appId: "com.t3tools.t3code" }),
      /must be 'dev\.hafencity\.dev\.agents'/,
    );
    assert.throws(
      () => parseReleaseConfig({ ...validConfig, version: "1.0.106" }),
      /cannot be lower than legacy version/,
    );
    assert.throws(
      () =>
        parseReleaseConfig({
          ...validConfig,
          protocolSchemes: ["t3code", "t3code-dev"],
        }),
      /twentyfirst-agents/,
    );
  });

  it("compares stable versions without lexicographic mistakes", () => {
    assert.equal(compareStableVersions("1.0.108", "1.0.107"), 1);
    assert.equal(compareStableVersions("1.10.0", "1.9.99"), 1);
    assert.equal(compareStableVersions("2.0.0", "2.0.0"), 0);
    assert.equal(compareStableVersions("2.0.0", "2.0.1"), -1);
  });

  it("skips an already-live push, permits dry runs, and rejects downgrades", () => {
    assert.deepStrictEqual(
      decideRelease({
        action: "publish",
        desiredVersion: "1.0.108",
        liveVersion: "1.0.108",
        liveStagingPercentage: 100,
      }),
      {
        decision: "skip",
        shouldBuild: false,
        shouldPublish: false,
        reason: "2code 1.0.108 is already live.",
      },
    );
    assert.equal(
      decideRelease({
        action: "dry-run",
        desiredVersion: "1.0.108",
        liveVersion: "1.0.108",
        liveStagingPercentage: 100,
      }).decision,
      "build",
    );
    assert.throws(
      () =>
        decideRelease({
          action: "publish",
          desiredVersion: "1.0.107",
          liveVersion: "1.0.108",
          liveStagingPercentage: 100,
        }),
      /older than live version/,
    );
  });

  it("only promotes a live staged rollout forward", () => {
    const promoted = decideRelease({
      action: "promote",
      desiredVersion: "1.0.108",
      liveVersion: "1.0.108",
      liveStagingPercentage: 10,
      targetStagingPercentage: 50,
    });
    assert.equal(promoted.decision, "promote");
    assert.throws(
      () =>
        decideRelease({
          action: "promote",
          desiredVersion: "1.0.108",
          liveVersion: "1.0.108",
          liveStagingPercentage: 50,
          targetStagingPercentage: 25,
        }),
      /must exceed live percentage/,
    );
  });

  it("resumes a beta-first publish without rebuilding different same-version bytes", () => {
    const resumed = decideReleaseAcrossChannels({
      action: "publish",
      desiredVersion: "1.0.108",
      latestVersion: "1.0.107",
      betaVersion: "1.0.108",
      latestStagingPercentage: 100,
      betaStagingPercentage: 25,
      channelsHaveIdenticalManifest: false,
    });
    assert.equal(resumed.decision, "resume");
    assert.equal(resumed.shouldBuild, false);
    assert.equal(resumed.shouldPublish, true);

    assert.throws(
      () =>
        decideReleaseAcrossChannels({
          action: "publish",
          desiredVersion: "1.0.108",
          latestVersion: "1.0.108",
          betaVersion: "1.0.108",
          latestStagingPercentage: 25,
          betaStagingPercentage: 25,
          channelsHaveIdenticalManifest: false,
        }),
      /different manifests/,
    );
  });

  it("retries partial promotion and recovery channel-by-channel", () => {
    const promotion = decideReleaseAcrossChannels({
      action: "promote",
      desiredVersion: "1.0.108",
      latestVersion: "1.0.108",
      betaVersion: "1.0.108",
      latestStagingPercentage: 25,
      betaStagingPercentage: 50,
      channelsHaveIdenticalManifest: false,
      targetStagingPercentage: 50,
    });
    assert.equal(promotion.decision, "promote");

    const recovery = decideReleaseAcrossChannels({
      action: "recovery",
      desiredVersion: "1.0.108",
      latestVersion: "1.0.108",
      betaVersion: "1.0.107",
      latestStagingPercentage: 25,
      betaStagingPercentage: 100,
      channelsHaveIdenticalManifest: false,
      recoveryVersion: "1.0.108",
    });
    assert.equal(recovery.decision, "recover");
  });

  it("uses electron-updater stagingPercentage and removes it at 100 percent", () => {
    const raw = `version: 1.0.108
files:
  - url: 2code-1.0.108-arm64-mac.zip
    sha512: zip
    size: 3
releaseDate: '2026-08-08T12:00:00.000Z'
`;
    const staged = serializeManifestWithRollout(raw, "test.yml", 20);
    assert.match(staged, /stagingPercentage: 20/);
    assert.equal(manifestStagingPercentage(readManifest(staged, "test.yml")), 20);
    const complete = serializeManifestWithRollout(staged, "test.yml", 100);
    assert.equal(complete.includes("stagingPercentage"), false);
    assert.equal(manifestStagingPercentage(readManifest(complete, "test.yml")), 100);
  });

  it("content-addresses prepared payloads and verifies every hash and blockmap", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "2code-release-test-"));
    try {
      const config = parseReleaseConfig(validConfig);
      const [zipName, dmgName] = expectedArtifactNames(config);
      await NodeFSP.writeFile(NodePath.join(directory, zipName), "zip-content");
      await NodeFSP.writeFile(NodePath.join(directory, dmgName), "dmg-content");
      await NodeFSP.writeFile(NodePath.join(directory, `${zipName}.blockmap`), "zip-map");
      await NodeFSP.writeFile(NodePath.join(directory, `${dmgName}.blockmap`), "dmg-map");
      await NodeFSP.writeFile(
        NodePath.join(directory, "latest-mac.yml"),
        `version: 1.0.108
files:
  - url: ${zipName}
    sha512: old
    size: 1
  - url: ${dmgName}
    sha512: old
    size: 1
path: ${zipName}
sha512: old
releaseDate: '2026-08-08T12:00:00.000Z'
`,
      );

      const plan = await prepareReleaseArtifacts({
        config,
        artifactDirectory: directory,
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      });
      assert.equal(plan.payloads.length, 4);
      assert.ok(plan.payloads.every((payload) => payload.remotePath.startsWith("objects/")));
      assert.equal(
        plan.payloads.find((payload) => payload.localName === zipName)?.sha512,
        sha512("zip-content"),
      );
      await verifyPreparedArtifacts({ config, artifactDirectory: directory });

      await NodeFSP.writeFile(NodePath.join(directory, zipName), "tampered");
      await expect(
        verifyPreparedArtifacts({ config, artifactDirectory: directory }),
      ).rejects.toThrow(/does not match its release plan/);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

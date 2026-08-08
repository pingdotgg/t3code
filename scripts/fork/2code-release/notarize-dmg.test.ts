import { assert, describe, it } from "@effect/vitest";

import { parseReleaseConfig } from "./release-core.ts";
import { resolveDmgNotarizationOptions } from "./notarize-dmg.ts";

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

describe("2code disk image notarization", () => {
  it("targets the signed legacy disk image with the protected Apple credentials", () => {
    const options = resolveDmgNotarizationOptions(config, "/tmp/release-2code", {
      APPLE_ID: "release@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_TEAM_ID: config.teamId,
    });

    assert.deepStrictEqual(options, {
      appPath: "/tmp/release-2code/2code-1.0.108-arm64.dmg",
      appleId: "release@example.com",
      appleIdPassword: "app-password",
      teamId: "D78YC33UVC",
    });
  });

  it("rejects missing credentials and a mismatched signing team", () => {
    assert.throws(
      () =>
        resolveDmgNotarizationOptions(config, "/tmp/release-2code", {
          APPLE_ID: "release@example.com",
          APPLE_TEAM_ID: config.teamId,
        }),
      /APPLE_APP_SPECIFIC_PASSWORD/,
    );
    assert.throws(
      () =>
        resolveDmgNotarizationOptions(config, "/tmp/release-2code", {
          APPLE_ID: "release@example.com",
          APPLE_APP_SPECIFIC_PASSWORD: "app-password",
          APPLE_TEAM_ID: "WRONGTEAM1",
        }),
      /frozen 2code identity/,
    );
  });
});

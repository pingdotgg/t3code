import { assert, describe, it } from "@effect/vitest";

import { parseReleaseConfig } from "./release-core.ts";
import {
  verifyAppUpdateConfiguration,
  verifyBundlePlist,
  verifyDesignatedRequirement,
  verifyEntitlements,
} from "./verify-macos.ts";

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

describe("2code macOS release verification", () => {
  it("requires the legacy app identity and only its non-conflicting deep link", () => {
    verifyBundlePlist(config, {
      CFBundleIdentifier: config.appId,
      CFBundleName: "2code",
      CFBundleExecutable: "2code",
      CFBundleShortVersionString: config.version,
      CFBundleURLTypes: [{ CFBundleURLSchemes: [...config.protocolSchemes] }],
    });
    assert.throws(
      () =>
        verifyBundlePlist(config, {
          CFBundleIdentifier: "com.t3tools.t3code",
          CFBundleName: "2code",
          CFBundleExecutable: "2code",
          CFBundleShortVersionString: config.version,
          CFBundleURLTypes: [{ CFBundleURLSchemes: [...config.protocolSchemes] }],
        }),
      /Bundle ID/,
    );
    assert.throws(
      () =>
        verifyBundlePlist(config, {
          CFBundleIdentifier: config.appId,
          CFBundleName: "2code",
          CFBundleExecutable: "2code",
          CFBundleShortVersionString: config.version,
          CFBundleURLTypes: [{ CFBundleURLSchemes: ["twentyfirst-agents", "t3code"] }],
        }),
      /must be exactly/,
    );
  });

  it("requires the generic R2 feed and legacy cache directory", () => {
    verifyAppUpdateConfiguration(
      config,
      `provider: generic
url: https://updates.example.com/releases/desktop
updaterCacheDirName: 2code-updater
`,
    );
    assert.throws(
      () => verifyAppUpdateConfiguration(config, "provider: github\nurl: wrong\n"),
      /generic provider/,
    );
  });

  it("requires the full legacy hardened-runtime entitlement set", () => {
    const entitlementXml = [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.network.client",
      "com.apple.security.network.server",
      "com.apple.security.device.audio-input",
    ]
      .map((key) => `<key>${key}</key><true/>`)
      .join("\n");
    verifyEntitlements(entitlementXml);
    assert.throws(
      () =>
        verifyEntitlements(
          entitlementXml.replace("com.apple.security.device.audio-input", "missing"),
        ),
      /audio-input/,
    );
  });

  it("accepts the designated requirement emitted on codesign stdout", () => {
    verifyDesignatedRequirement(
      config,
      `designated => identifier "${config.appId}" and anchor apple generic and certificate leaf[subject.OU] = ${config.teamId}`,
    );
    assert.throws(
      () =>
        verifyDesignatedRequirement(
          config,
          `designated => identifier "${config.appId}" and anchor apple generic`,
        ),
      /legacy identity/,
    );
  });
});

import { assert, describe, it } from "@effect/vitest";
import { PNG } from "pngjs";

import { parseReleaseConfig } from "./release-core.ts";
import {
  MAC_ICON_REPRESENTATIONS,
  verifyAppUpdateConfiguration,
  verifyBundlePlist,
  verifyDesignatedRequirement,
  verifyDeveloperIdSignature,
  verifyEntitlements,
  verifyIconRepresentationNames,
  verifyLegacyIconSource,
  verifyPngPixelsMatch,
} from "./verify-macos.ts";

function makePng(width: number, height: number, red: number): Uint8Array {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = red;
    png.data[index + 1] = 20;
    png.data[index + 2] = 30;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

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
      CFBundleIconFile: "icon.icns",
      CFBundleShortVersionString: config.version,
      CFBundleURLTypes: [{ CFBundleURLSchemes: [...config.protocolSchemes] }],
    });
    assert.throws(
      () =>
        verifyBundlePlist(config, {
          CFBundleIdentifier: "com.t3tools.t3code",
          CFBundleName: "2code",
          CFBundleExecutable: "2code",
          CFBundleIconFile: "icon.icns",
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
          CFBundleIconFile: "icon.icns",
          CFBundleShortVersionString: config.version,
          CFBundleURLTypes: [{ CFBundleURLSchemes: ["twentyfirst-agents", "t3code"] }],
        }),
      /must be exactly/,
    );
    assert.throws(
      () =>
        verifyBundlePlist(config, {
          CFBundleIdentifier: config.appId,
          CFBundleName: "2code",
          CFBundleExecutable: "2code",
          CFBundleIconFile: "wrong.icns",
          CFBundleShortVersionString: config.version,
          CFBundleURLTypes: [{ CFBundleURLSchemes: [...config.protocolSchemes] }],
        }),
      /Bundle icon/,
    );
  });

  it("rejects Finder and Dock icons that differ from the legacy 2code artwork", () => {
    const expected = makePng(1, 1, 10);
    verifyPngPixelsMatch(expected, expected, "Dock icon");
    assert.throws(
      () => verifyPngPixelsMatch(expected, makePng(1, 1, 11), "Finder icon"),
      /Finder icon does not match the legacy 2code icon/,
    );
    assert.throws(
      () => verifyPngPixelsMatch(expected, makePng(2, 1, 10), "Dock icon"),
      /Dock icon does not match the legacy 2code icon/,
    );

    const names = MAC_ICON_REPRESENTATIONS.map(({ name }) => name);
    verifyIconRepresentationNames(names);
    assert.throws(() => verifyIconRepresentationNames(names.slice(1)), /complete legacy/);
    assert.deepStrictEqual(
      MAC_ICON_REPRESENTATIONS.filter(({ pixelExact }) => !pixelExact).map(({ name }) => name),
      ["icon_16x16.png", "icon_32x32.png"],
    );

    assert.throws(
      () =>
        verifyLegacyIconSource(
          expected,
          "f899498a11e4cd418b11f779fc02db00b7d53f2469720b05f22c9f65cd6f5e9e",
        ),
      /frozen legacy artwork/,
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

  it("requires the frozen Developer ID team and authority for each artifact", () => {
    const signature = `Authority=Developer ID Application: hafencity.dev GmbH (${config.teamId})
TeamIdentifier=${config.teamId}`;
    verifyDeveloperIdSignature(config, signature, "Signed disk image");
    assert.throws(
      () =>
        verifyDeveloperIdSignature(
          config,
          signature.replace(config.teamId, "WRONGTEAM1"),
          "Signed disk image",
        ),
      /Developer ID identity/,
    );
    assert.throws(
      () =>
        verifyDeveloperIdSignature(
          config,
          signature.replace(`TeamIdentifier=${config.teamId}`, "TeamIdentifier=WRONGTEAM1"),
          "Signed disk image",
        ),
      /TeamIdentifier/,
    );
  });
});

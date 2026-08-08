import { assert, it } from "@effect/vitest";

import {
  DESKTOP_DISTRIBUTIONS,
  renderTwoCodeLegacyMacEntitlements,
  resolveDesktopDistributionStageMetadata,
  resolveDesktopDistributionProfile,
  TWO_CODE_PRODUCTION_DISTRIBUTION,
} from "./2code-desktop-distribution.ts";

it("defines the legacy-compatible 2code production identity", () => {
  const profile = resolveDesktopDistributionProfile(TWO_CODE_PRODUCTION_DISTRIBUTION);

  assert.deepStrictEqual(DESKTOP_DISTRIBUTIONS, ["2code-production"]);
  assert.deepStrictEqual(profile, {
    id: "2code-production",
    packageName: "2code",
    appId: "dev.hafencity.dev.agents",
    productName: "2code",
    executableName: "2code",
    artifactNames: {
      default: "2code-${version}-${arch}.${ext}",
      mac: "2code-${version}-${arch}-mac.${ext}",
      dmg: "2code-${version}-${arch}.${ext}",
    },
    description: "2code desktop build",
    protocols: {
      name: "2code",
      schemes: ["twentyfirst-agents"],
    },
    updates: {
      provider: "generic",
      url: "https://pub-cb9e18e7e55d46cf9c297e4b612881f7.r2.dev/releases/desktop",
      updaterCacheDirName: "2code-updater",
    },
    macSigning: "legacy-entitlements",
  });
  assert.equal(`${profile?.packageName}-updater`, profile?.updates.updaterCacheDirName);
});

it("keeps the default desktop build free of a fork distribution profile", () => {
  assert.isUndefined(resolveDesktopDistributionProfile(undefined));
  assert.deepStrictEqual(resolveDesktopDistributionStageMetadata(undefined, "0.0.32"), {});
});

it("keeps distribution and embedded runtime versions separate", () => {
  const profile = resolveDesktopDistributionProfile(TWO_CODE_PRODUCTION_DISTRIBUTION);

  assert.deepStrictEqual(resolveDesktopDistributionStageMetadata(profile, "0.0.32"), {
    t3codeDistribution: "2code-production",
    t3codeRuntimeVersion: "0.0.32",
  });
});

it("renders the non-App-Sandbox entitlements used by the existing 2code signature", () => {
  const entitlements = renderTwoCodeLegacyMacEntitlements();

  assert.include(entitlements, "<key>com.apple.security.cs.allow-jit</key>");
  assert.include(entitlements, "<key>com.apple.security.cs.disable-library-validation</key>");
  assert.include(entitlements, "<key>com.apple.security.network.client</key>");
  assert.include(entitlements, "<key>com.apple.security.device.audio-input</key>");
  assert.notInclude(entitlements, "com.apple.application-identifier");
  assert.notInclude(entitlements, "com.apple.developer.associated-domains");
});

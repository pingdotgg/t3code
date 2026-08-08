export const TWO_CODE_PRODUCTION_DISTRIBUTION = "2code-production" as const;

export const DESKTOP_DISTRIBUTIONS = [TWO_CODE_PRODUCTION_DISTRIBUTION] as const;
export type DesktopDistribution = (typeof DESKTOP_DISTRIBUTIONS)[number];

export interface DesktopDistributionProfile {
  readonly id: DesktopDistribution;
  readonly appId: string;
  readonly productName: string;
  readonly executableName: string;
  readonly artifactNames: {
    readonly default: string;
    readonly mac: string;
    readonly dmg: string;
  };
  readonly description: string;
  readonly protocols: {
    readonly name: string;
    readonly schemes: readonly string[];
  };
  readonly updates: {
    readonly provider: "generic";
    readonly url: string;
    readonly updaterCacheDirName: string;
  };
  readonly macSigning: "legacy-entitlements";
}

export const TWO_CODE_PRODUCTION_PROFILE: DesktopDistributionProfile = {
  id: TWO_CODE_PRODUCTION_DISTRIBUTION,
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
    // Keep OS-level ownership identical to the installed legacy app. The
    // renderer's private t3code:// scheme is registered inside Electron and
    // does not need to compete with a concurrently installed T3 Code app.
    schemes: ["twentyfirst-agents"],
  },
  updates: {
    provider: "generic",
    url: "https://pub-cb9e18e7e55d46cf9c297e4b612881f7.r2.dev/releases/desktop",
    updaterCacheDirName: "2code-updater",
  },
  macSigning: "legacy-entitlements",
};

export function resolveDesktopDistributionProfile(
  distribution: DesktopDistribution | undefined,
): DesktopDistributionProfile | undefined {
  return distribution === TWO_CODE_PRODUCTION_DISTRIBUTION
    ? TWO_CODE_PRODUCTION_PROFILE
    : undefined;
}

export function resolveDesktopDistributionStageMetadata(
  profile: DesktopDistributionProfile | undefined,
  runtimeVersion: string,
):
  | {
      readonly t3codeDistribution: DesktopDistribution;
      readonly t3codeRuntimeVersion: string;
    }
  | Record<string, never> {
  return profile
    ? {
        t3codeDistribution: profile.id,
        t3codeRuntimeVersion: runtimeVersion,
      }
    : {};
}

export function renderTwoCodeLegacyMacEntitlements(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.network.server</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
  </dict>
</plist>
`;
}

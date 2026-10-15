const ANTIGRAVITY_RELEASE_VERSION = "1.4.0";

export interface AntigravityReleaseAsset {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly executable: {
    readonly name: string;
    readonly bytes: number;
  };
  readonly harness: {
    readonly name: string;
    readonly bytes: number;
  };
}

// URLs come from the official registry. Hashes and sizes were checked on 2026-10-14.
// https://github.com/agentclientprotocol/registry/blob/594f25bfb5ef48082c11f3c43ad0c11f60488e9d/antigravity-acp/agent.json
const releaseAssets = new Map<string, AntigravityReleaseAsset>([
  [
    "darwin-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.0-darwin-arm64.zip",
      sha256: "21a32eeab85b394a515510c84539bda4b2504bf2917e0a201f5c4130b13581a5",
      archiveBytes: 112_734_313,
      executable: { name: "agy_acp_server.par", bytes: 280_980_064 },
      harness: { name: "localharness_external", bytes: 120_246_928 },
    },
  ],
  [
    "darwin-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.0-darwin-x86_64.zip",
      sha256: "407b6b8ef167bb207d1effdbd488bacf63ba7dab2b47d4a47d8ea3710a8c0f55",
      archiveBytes: 118_343_529,
      executable: { name: "agy_acp_server.par", bytes: 285_170_112 },
      harness: { name: "localharness_external", bytes: 124_910_048 },
    },
  ],
  [
    "linux-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-x86_64.zip",
      sha256: "fbb2d54dd94fb897845308d3b6b46187c627f1c60078ded81adeeaf8b90c5d7a",
      archiveBytes: 336_175_910,
      executable: { name: "agy_acp_server.par", bytes: 930_814_465 },
      harness: { name: "localharness_external", bytes: 131_187_512 },
    },
  ],
  [
    "linux-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-arm64.zip",
      sha256: "3dc43a21f5402b23a4dba7b320a6745e9dbf4b6ead912ce9fc76011ea3a08a7e",
      archiveBytes: 321_912_925,
      executable: { name: "agy_acp_server.par", bytes: 933_404_508 },
      harness: { name: "localharness_external", bytes: 124_895_000 },
    },
  ],
  [
    "win32-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-x86_64.zip",
      sha256: "d737aad2d6388e071bc907db415c129a256915d275f436e68f10dcdf6af896da",
      archiveBytes: 125_646_049,
      executable: { name: "agy_acp_server.exe", bytes: 82_245_832 },
      harness: { name: "localharness_external.exe", bytes: 146_036_888 },
    },
  ],
  [
    "win32-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-arm64.zip",
      sha256: "37fac14835f06caf05b4b93fed59a0e16e7c716e3ec95f03d4779a61abe3c2e6",
      archiveBytes: 126_083_066,
      executable: { name: "agy_acp_server.exe", bytes: 86_867_784 },
      harness: { name: "localharness_external.exe", bytes: 136_970_904 },
    },
  ],
]);

export function resolveAntigravityReleaseAsset(
  platform: NodeJS.Platform,
  arch: string,
): AntigravityReleaseAsset | null {
  return releaseAssets.get(`${platform}-${arch}`) ?? null;
}

// 1.4.2 through 1.4.4 write skills/system/run-workflow/SKILL.md into every session workspace.
const ANTIGRAVITY_RELEASE_VERSION = "1.4.1";

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

const releaseAssets = new Map<string, AntigravityReleaseAsset>([
  [
    "darwin-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-arm64.zip",
      sha256: "f9bdd68291ae78c38d2141e63bc86b84e6cc7b9f60f71652c68435a7943deb17",
      archiveBytes: 112_737_434,
      executable: { name: "agy_acp_server.par", bytes: 280_996_576 },
      harness: { name: "localharness_external", bytes: 120_246_928 },
    },
  ],
  [
    "darwin-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-x86_64.zip",
      sha256: "27e31f096874704f14167b07ef9e84cc77134615ee41d024f7b1c957add85307",
      archiveBytes: 118_349_036,
      executable: { name: "agy_acp_server.par", bytes: 285_186_624 },
      harness: { name: "localharness_external", bytes: 124_910_048 },
    },
  ],
  [
    "linux-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.1-linux-x86_64.zip",
      sha256: "2e37012ceb2a5c7fc7309b6e6596234fb637ee3c62a5199f65d4cbe777871384",
      archiveBytes: 336_170_339,
      executable: { name: "agy_acp_server.par", bytes: 930_826_753 },
      harness: { name: "localharness_external", bytes: 131_187_512 },
    },
  ],
  [
    "linux-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.1-linux-arm64.zip",
      sha256: "609336a1c97545487e3ddd55dbd153dc0f40f4e6534486cc1c5f4c0ebb85c2da",
      archiveBytes: 321_922_507,
      executable: { name: "agy_acp_server.par", bytes: 933_416_796 },
      harness: { name: "localharness_external", bytes: 124_895_000 },
    },
  ],
  [
    "win32-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.1-windows-x86_64.zip",
      sha256: "5f5b7d0328df17c128b2be338d4567b0d24e56ace8196e88794fec37d1372554",
      archiveBytes: 129_599_308,
      executable: { name: "agy_acp_server.exe", bytes: 86_098_784 },
      harness: { name: "localharness_external.exe", bytes: 146_036_888 },
    },
  ],
  [
    "win32-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.1-windows-arm64.zip",
      sha256: "24c52bbc12aae20f55eb53d373669412d95a9c44fd59be4ea4e355918b91fbf7",
      archiveBytes: 132_507_344,
      executable: { name: "agy_acp_server.exe", bytes: 93_197_744 },
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

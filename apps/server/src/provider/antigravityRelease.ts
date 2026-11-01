// Hashes and sizes match the official ACP registry release. Like 1.4.2 through 1.4.4, it writes a
// run-workflow skill into the workspace unless T3 disables the tool (antigravitySessionMeta).
const ANTIGRAVITY_RELEASE_VERSION = "1.4.5";
// Windows has not been qualified on 1.4.5; it stays on 1.4.1, which takes the pre-1.4.5 paths.
const ANTIGRAVITY_WINDOWS_RELEASE_VERSION = "1.4.1";

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
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip",
      sha256: "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f",
      archiveBytes: 97_923_855,
      executable: { name: "agy_acp_server.par", bytes: 178_915_920 },
      harness: { name: "localharness_external", bytes: 122_957_936 },
    },
  ],
  [
    "darwin-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-x86_64.zip",
      sha256: "b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a",
      archiveBytes: 103_577_295,
      executable: { name: "agy_acp_server.par", bytes: 183_127_600 },
      harness: { name: "localharness_external", bytes: 127_612_208 },
    },
  ],
  [
    "linux-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip",
      sha256: "923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b",
      archiveBytes: 321_783_181,
      executable: { name: "agy_acp_server.par", bytes: 826_226_766 },
      harness: { name: "localharness_external", bytes: 133_926_136 },
    },
  ],
  [
    "linux-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-arm64.zip",
      sha256: "7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056",
      archiveBytes: 307_829_008,
      executable: { name: "agy_acp_server.par", bytes: 831_194_025 },
      harness: { name: "localharness_external", bytes: 127_512_832 },
    },
  ],
  [
    "win32-x64",
    {
      version: ANTIGRAVITY_WINDOWS_RELEASE_VERSION,
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
      version: ANTIGRAVITY_WINDOWS_RELEASE_VERSION,
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

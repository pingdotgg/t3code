export const ANTIGRAVITY_RELEASE_VERSION = "agy_acp_server_20260818_01_RC01";

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

// URLs come from the official registry. Hashes and sizes were checked on 2026-09-02.
// https://github.com/agentclientprotocol/registry/blob/536e378b70a7a6d5f078a9160180e3569a23253c/antigravity-acp/agent.json
const releaseAssets = new Map<string, AntigravityReleaseAsset>([
  [
    "darwin-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_20260818_01_RC01-darwin-arm64.zip",
      sha256: "f122ca7e7030a27f9649da4cf1a7d80e12c48c5f6118ff35affc34d56cbf83dd",
      archiveBytes: 314_500_221,
      executable: { name: "agy_acp_server.par", bytes: 792_105_680 },
      harness: { name: "localharness_external", bytes: 101_551_680 },
    },
  ],
  [
    "linux-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_20260818_01_RC01-linux-x86_64.zip",
      sha256: "ce3f09628575b25497cf5a3c19d073b49acb80f1dab1ff8592919e9c9b8799e1",
      archiveBytes: 543_411_011,
      executable: { name: "agy_acp_server.par", bytes: 1_529_513_909 },
      harness: { name: "localharness_external", bytes: 117_532_520 },
    },
  ],
  [
    "linux-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_20260818_01_RC01-linux-arm64.zip",
      sha256: "70fcdac70684de60f7a0eb16ea497d6cc4498728420f060e0850cfc9a9329b40",
      archiveBytes: 524_995_159,
      executable: { name: "agy_acp_server.par", bytes: 1_519_373_648 },
      harness: { name: "localharness_external", bytes: 110_601_552 },
    },
  ],
  [
    "win32-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_20260818_01_RC01-windows-x86_64.zip",
      sha256: "35c7dd169c2794172ce02e9444a6db4a8ed4bb11398be07976cac2ee494f44e6",
      archiveBytes: 331_985_114,
      executable: { name: "agy_acp_server.exe", bytes: 297_200_088 },
      harness: { name: "localharness_external.exe", bytes: 122_038_424 },
    },
  ],
  [
    "win32-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_20260818_01_RC01-windows-arm64.zip",
      sha256: "1522056748d45fbc34d0be72b41b99b0637be1b4caad0b34d37eb16d04ccb9c4",
      archiveBytes: 332_484_576,
      executable: { name: "agy_acp_server.exe", bytes: 301_449_928 },
      harness: { name: "localharness_external.exe", bytes: 114_173_080 },
    },
  ],
]);

export function resolveAntigravityReleaseAsset(
  platform: NodeJS.Platform,
  arch: string,
): AntigravityReleaseAsset | null {
  return releaseAssets.get(`${platform}-${arch}`) ?? null;
}

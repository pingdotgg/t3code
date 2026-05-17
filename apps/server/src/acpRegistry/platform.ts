import type { AcpRegistryBinaryPlatform } from "@t3tools/contracts";

const PLATFORMS: Record<string, "darwin" | "linux" | "windows"> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const ARCHES: Record<string, "aarch64" | "x86_64"> = {
  arm64: "aarch64",
  x64: "x86_64",
};

export function resolveCurrentPlatform(
  nodePlatform: NodeJS.Platform,
  nodeArch: string,
): AcpRegistryBinaryPlatform | undefined {
  const platform = PLATFORMS[nodePlatform];
  const arch = ARCHES[nodeArch];
  return platform && arch ? (`${platform}-${arch}` as AcpRegistryBinaryPlatform) : undefined;
}

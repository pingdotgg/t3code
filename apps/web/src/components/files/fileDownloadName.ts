import type { ExecutionEnvironmentPlatformOs } from "@t3tools/contracts";

export function fileDownloadName(path: string, hostOs?: ExecutionEnvironmentPlatformOs): string {
  const separator = hostOs === "windows" || hostOs === "unknown" ? /[\\/]/ : "/";
  return path.split(separator).at(-1) || path;
}

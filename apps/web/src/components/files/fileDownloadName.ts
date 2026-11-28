import type { ExecutionEnvironmentPlatformOs } from "@t3tools/contracts";

export type FileDownloadPathKind = "workspace-relative" | "host";

export function fileDownloadName(
  path: string,
  pathKind: FileDownloadPathKind,
  hostOs: ExecutionEnvironmentPlatformOs = "unknown",
): string {
  const isSingleSlashRooted = path.startsWith("/") && !path.startsWith("//");
  const usesWindowsSeparators =
    pathKind === "host" && (hostOs === "windows" || (hostOs === "unknown" && !isSingleSlashRooted));
  const separator = usesWindowsSeparators ? /[\\/]/ : "/";
  return path.split(separator).at(-1) || path;
}

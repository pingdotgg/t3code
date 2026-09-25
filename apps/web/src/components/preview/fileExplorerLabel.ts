import type { ExecutionEnvironmentPlatformOs, FileManagerRevealKind } from "@t3tools/contracts";

export type FileManagerRevealName = "Finder" | "File Explorer" | "Files";
export type FileManagerOpenName = "Finder" | "File Explorer" | "File Manager";

function labelForFileManager(fileManagerName: FileManagerRevealName): string {
  return fileManagerName === "Files" ? "Open Containing Folder" : `Reveal in ${fileManagerName}`;
}

export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Reveal in Finder";
  if (normalized.includes("win")) return "Reveal in File Explorer";
  return "Reveal in Files";
}

export function fileManagerOpenNameForOs(os: ExecutionEnvironmentPlatformOs): FileManagerOpenName {
  if (os === "darwin") return "Finder";
  if (os === "windows") return "File Explorer";
  return "File Manager";
}

export function fileManagerRevealNameForOs(
  os: ExecutionEnvironmentPlatformOs,
): FileManagerRevealName {
  if (os === "darwin") return "Finder";
  if (os === "windows") return "File Explorer";
  return "Files";
}

export function fileManagerRevealNameForKind(kind: FileManagerRevealKind): FileManagerRevealName {
  if (kind === "finder") return "Finder";
  if (kind === "file-explorer") return "File Explorer";
  return "Files";
}

export function revealInFileExplorerLabelForManager(
  fileManagerName: FileManagerRevealName,
): string {
  return labelForFileManager(fileManagerName);
}

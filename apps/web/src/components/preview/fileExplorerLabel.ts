import type { ExecutionEnvironmentPlatformOs, FileManagerRevealKind } from "@t3tools/contracts";

import { translateDynamic } from "../../i18nCore";

const td = (key: string, options?: Record<string, unknown>) =>
  translateDynamic(`preview:${key}`, options);

export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return td("revealInFinder");
  if (normalized.includes("win")) return td("revealInFileExplorer");
  return td("revealInFiles");
}

export function revealInFileExplorerLabelForOs(os: ExecutionEnvironmentPlatformOs): string {
  if (os === "darwin") return td("revealInFinder");
  if (os === "windows") return td("revealInFileExplorer");
  return td("revealInFiles");
}

export function revealInFileExplorerLabelForKind(kind: FileManagerRevealKind): string {
  if (kind === "finder") return td("revealInFinder");
  if (kind === "file-explorer") return td("revealInFileExplorer");
  return td("revealInFiles");
}

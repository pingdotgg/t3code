import { translateNow } from "../media/translateNow";
import type { ExecutionEnvironmentPlatformOs, FileManagerRevealKind } from "@t3tools/contracts";

export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return translateNow("review.preview.reveal.finder");
  if (normalized.includes("win")) return translateNow("review.preview.reveal.fileExplorer");
  return translateNow("review.preview.reveal.files");
}

export function revealInFileExplorerLabelForOs(os: ExecutionEnvironmentPlatformOs): string {
  if (os === "darwin") return translateNow("review.preview.reveal.finder");
  if (os === "windows") return translateNow("review.preview.reveal.fileExplorer");
  return translateNow("review.preview.reveal.files");
}

export function revealInFileExplorerLabelForKind(kind: FileManagerRevealKind): string {
  if (kind === "finder") return translateNow("review.preview.reveal.finder");
  if (kind === "file-explorer") return translateNow("review.preview.reveal.fileExplorer");
  return translateNow("review.preview.reveal.files");
}

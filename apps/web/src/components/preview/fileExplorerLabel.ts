import type { Translate } from "~/i18n";

export function revealInFileExplorerLabel(platform: string, t?: Translate): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return t?.("preview.revealFinder") ?? "Reveal in Finder";
  if (normalized.includes("win")) {
    return t?.("preview.revealFileExplorer") ?? "Reveal in File Explorer";
  }
  return t?.("preview.revealFiles") ?? "Reveal in Files";
}

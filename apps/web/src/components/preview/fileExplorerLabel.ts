import type { ExecutionEnvironmentPlatformOs, FileManagerRevealKind } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/** Components pass `useMessages()` so labels follow a language switch. */
export function revealInFileExplorerLabel(platform: string, resolve: MessageResolver = m): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return resolve(msg("Reveal in Finder"));
  if (normalized.includes("win")) return resolve(msg("Reveal in File Explorer"));
  return resolve(msg("Reveal in Files"));
}

export function revealInFileExplorerLabelForOs(
  os: ExecutionEnvironmentPlatformOs,
  resolve: MessageResolver = m,
): string {
  if (os === "darwin") return resolve(msg("Reveal in Finder"));
  if (os === "windows") return resolve(msg("Reveal in File Explorer"));
  return resolve(msg("Reveal in Files"));
}

export function revealInFileExplorerLabelForKind(
  kind: FileManagerRevealKind,
  resolve: MessageResolver = m,
): string {
  if (kind === "finder") return resolve(msg("Reveal in Finder"));
  if (kind === "file-explorer") return resolve(msg("Reveal in File Explorer"));
  return resolve(msg("Reveal in Files"));
}

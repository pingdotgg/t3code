import type { PreviewSessionSnapshot, ProjectScript } from "@t3tools/contracts";
import { projectScriptPreviewUrl, projectScriptReservesPort } from "@t3tools/shared/projectScripts";

export function shouldShowPreviewEmptyState(snapshot: PreviewSessionSnapshot | null): boolean {
  return snapshot === null || snapshot.navStatus._tag === "Idle";
}

export function getConfiguredPreviewUrls(
  scripts: ReadonlyArray<ProjectScript> | undefined,
  ports: Readonly<Record<string, number>> = {},
): ReadonlyArray<string> {
  return (
    scripts?.flatMap((script) => {
      if (projectScriptReservesPort(script) && ports[script.id] === undefined) return [];
      const url = projectScriptPreviewUrl(script, ports[script.id]);
      return url ? [url] : [];
    }) ?? []
  );
}

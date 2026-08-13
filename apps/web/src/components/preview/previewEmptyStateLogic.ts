import type { PreviewSessionSnapshot, ProjectScript } from "@t3tools/contracts";

import type { PreviewableServer } from "./useDiscoveredLocalServers";

export function shouldShowPreviewEmptyState(snapshot: PreviewSessionSnapshot | null): boolean {
  return snapshot === null || snapshot.navStatus._tag === "Idle";
}

export function getConfiguredPreviewUrls(
  scripts: ReadonlyArray<ProjectScript> | undefined,
): ReadonlyArray<string> {
  return scripts?.flatMap((script) => (script.previewUrl ? [script.previewUrl] : [])) ?? [];
}

export function findDiscoveredServerTargetPort(
  url: string,
  servers: ReadonlyArray<PreviewableServer>,
): number | undefined {
  return servers.find((server) => server.requestedUrl === url)?.port;
}

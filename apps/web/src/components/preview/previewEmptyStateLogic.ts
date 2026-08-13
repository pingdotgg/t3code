import type { PreviewSessionSnapshot, ProjectScript } from "@t3tools/contracts";

import { normalizeHistoryUrl } from "~/browserHistoryStore";

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
  const normalizedUrl = normalizeHistoryUrl(url);
  if (normalizedUrl === null) return undefined;
  return servers.find((server) => normalizeHistoryUrl(server.requestedUrl) === normalizedUrl)?.port;
}

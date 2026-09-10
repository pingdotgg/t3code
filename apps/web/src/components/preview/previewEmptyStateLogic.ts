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

export function findDiscoveredServerTarget(
  url: string,
  servers: ReadonlyArray<PreviewableServer>,
): { readonly port: number; readonly urlKind: PreviewableServer["urlKind"] } | undefined {
  const normalizedUrl = normalizeHistoryUrl(url);
  if (normalizedUrl === null) return undefined;
  const origin = new URL(normalizedUrl).origin;
  const server = servers.find((candidate) => {
    const normalizedRequestedUrl = normalizeHistoryUrl(candidate.requestedUrl);
    return normalizedRequestedUrl !== null && new URL(normalizedRequestedUrl).origin === origin;
  });
  return server ? { port: server.port, urlKind: server.urlKind } : undefined;
}

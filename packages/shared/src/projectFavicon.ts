import { WORKSPACE_IMAGE_PREVIEW_EXTENSIONS } from "./filePreview.ts";

export const PROJECT_FAVICON_FALLBACK_MARKER = "project-favicon-missing";

export const PROJECT_FAVICON_EXTENSIONS = [...WORKSPACE_IMAGE_PREVIEW_EXTENSIONS, ".icns"] as const;

export function isProjectFaviconPath(path: string): boolean {
  const literalPath = path.toLowerCase();
  return PROJECT_FAVICON_EXTENSIONS.some((extension) => literalPath.endsWith(extension));
}

export function getProjectFaviconResourceKey(
  environmentId: string,
  workspaceRoot: string,
  faviconPath?: string | null,
) {
  return JSON.stringify([environmentId, workspaceRoot, faviconPath || null]);
}

export function getProjectFaviconCacheKey(
  environmentId: string,
  workspaceRoot: string,
  url: string,
) {
  let revision = url;

  try {
    const pathname = new URL(url, "https://t3.invalid").pathname;
    revision = pathname.slice(pathname.lastIndexOf("/") + 1);
  } catch {
    // Keep the full value as a safe fallback for malformed URLs.
  }

  return JSON.stringify([environmentId, workspaceRoot, revision]);
}

export function isProjectFaviconFallbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;

  try {
    const pathname = new URL(url, "https://t3.invalid").pathname;
    return pathname.slice(pathname.lastIndexOf("/") + 1) === PROJECT_FAVICON_FALLBACK_MARKER;
  } catch {
    return false;
  }
}

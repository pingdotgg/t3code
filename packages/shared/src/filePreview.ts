import type { AssetResource, ThreadId } from "@t3tools/contracts";

export const WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = [".htm", ".html", ".pdf"] as const;

export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
] as const;

export const WORKSPACE_VIDEO_PREVIEW_EXTENSIONS = [".m4v", ".mov", ".mp4", ".webm"] as const;

/** Sources a client can load directly without a signed workspace asset URL. */
const DIRECT_MARKDOWN_MEDIA_SRC_PATTERN = /^(?:https?:|data:|blob:|\/\/)/i;

/** Web markdown URL normalization carries Windows drive paths as `/C:/…`. */
const ESCAPED_WINDOWS_DRIVE_PATH_PATTERN = /^\/[A-Za-z]:[\\/]/;

/** Paths that are absolute on either platform after Windows-drive unescaping. */
const ABSOLUTE_PATH_PATTERN = /^(?:[/\\]|[A-Za-z]:[\\/])/;

export type MarkdownMediaSource =
  | { readonly _tag: "Direct"; readonly url: string }
  | { readonly _tag: "Asset"; readonly resource: AssetResource };

function hasPreviewExtension(path: string, extensions: ReadonlyArray<string>): boolean {
  const pathWithoutQuery = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  return extensions.some((extension) => pathWithoutQuery.endsWith(extension));
}

export function isWorkspaceBrowserPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS);
}

export function isWorkspaceImagePreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS);
}

export function isWorkspaceVideoPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_VIDEO_PREVIEW_EXTENSIONS);
}

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return (
    isWorkspaceBrowserPreviewPath(path) ||
    isWorkspaceImagePreviewPath(path) ||
    isWorkspaceVideoPreviewPath(path)
  );
}

export function isDirectMarkdownMediaSource(src: string): boolean {
  return DIRECT_MARKDOWN_MEDIA_SRC_PATTERN.test(src);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function markdownMediaFileName(src: string): string {
  const withoutQuery = src.split(/[?#]/, 1)[0] ?? src;
  const basename = withoutQuery.slice(
    Math.max(withoutQuery.lastIndexOf("/"), withoutQuery.lastIndexOf("\\")) + 1,
  );
  return basename.length > 0 ? safeDecode(basename) : safeDecode(withoutQuery);
}

/**
 * Normalize markdown media into either a directly loadable URL or an asset RPC
 * resource. Absolute preview-tool artifact paths are served from the dedicated
 * artifact store; every other non-direct path is scoped to the thread worktree.
 */
export function resolveMarkdownMediaSource(src: string, threadId: ThreadId): MarkdownMediaSource {
  if (isDirectMarkdownMediaSource(src)) {
    return { _tag: "Direct", url: src };
  }

  const withoutQuery = src.split(/[?#]/, 1)[0] ?? src;
  const decoded = safeDecode(withoutQuery);
  const path = ESCAPED_WINDOWS_DRIVE_PATH_PATTERN.test(decoded) ? decoded.slice(1) : decoded;
  const artifactMatch = ABSOLUTE_PATH_PATTERN.test(path)
    ? /[/\\]browser-artifacts[/\\]([^/\\]+)$/.exec(path)
    : null;

  return {
    _tag: "Asset",
    resource: artifactMatch?.[1]
      ? { _tag: "browser-artifact", fileName: artifactMatch[1] }
      : {
          _tag: "workspace-file",
          threadId,
          path: path.startsWith("./") ? path.slice(2) : path,
        },
  };
}

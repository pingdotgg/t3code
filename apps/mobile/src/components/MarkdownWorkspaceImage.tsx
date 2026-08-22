import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import type { ReactNode } from "react";

import type { MarkdownImageRenderer } from "../native/SelectableMarkdownText";
import { useAssetUrl } from "../state/assets";

const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/;
const EXTERNAL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Workspace path for a markdown image src, or null when the src is external
 * (scheme or protocol-relative) or not an image. Relative results stay
 * workspace-relative; the server resolves them against the thread's workspace
 * root. `baseDir` anchors document-relative srcs, e.g. a nested README's own
 * folder in the file preview.
 */
export function resolveMarkdownImageWorkspacePath(src: string, baseDir?: string): string | null {
  const trimmed = src.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;
  if (!WINDOWS_DRIVE_PATTERN.test(trimmed) && EXTERNAL_SCHEME_PATTERN.test(trimmed)) return null;

  const path = safeDecode(trimmed.split(/[?#]/, 1)[0] ?? trimmed);
  if (path.length === 0 || !isWorkspaceImagePreviewPath(path)) return null;

  const isAbsolute =
    path.startsWith("/") || WINDOWS_DRIVE_PATTERN.test(path) || path.startsWith("\\\\");
  if (isAbsolute || !baseDir) return path;
  return `${baseDir.replace(/[\\/]+$/, "")}/${path}`;
}

/**
 * A markdown image whose src points into the workspace. The phone cannot fetch
 * the server's files by path, so the image waits for a signed asset URL; while
 * loading — or if the server refuses the path — the module's default frame
 * shows its empty placeholder, matching today's broken-image look.
 */
export function MarkdownWorkspaceImage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly path: string;
  readonly renderWithUri: (uri: string | undefined) => ReactNode;
}) {
  const uri = useAssetUrl(props.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadId,
    path: props.path,
  });
  return <>{props.renderWithUri(uri ?? undefined)}</>;
}

/**
 * Builds the `renderImage` override for markdown surfaces in a thread:
 * workspace srcs go through the signed asset flow, everything else keeps the
 * default rendering.
 */
export function createWorkspaceImageRenderer(context: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly baseDir?: string;
}): MarkdownImageRenderer {
  return (image, renderDefault) => {
    const path = resolveMarkdownImageWorkspacePath(image.href, context.baseDir);
    if (path === null) {
      return renderDefault(image.href);
    }
    return (
      <MarkdownWorkspaceImage
        environmentId={context.environmentId}
        threadId={context.threadId}
        path={path}
        renderWithUri={renderDefault}
      />
    );
  };
}

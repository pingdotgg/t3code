import { isWindowsAbsolutePath } from "@t3tools/shared/path";

import {
  normalizeMarkdownLinkDestination,
  parseFileUrlHref,
  safeDecodeURIComponent,
  splitMarkdownLinkSearchAndHash,
  stripSlashPrefixedWindowsDrive,
} from "./markdownLinks.ts";

const DIRECT_IMAGE_SOURCE_PATTERN = /^(?:https?:|data:|blob:|\/\/)/i;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export type MarkdownImageSource =
  | { readonly _tag: "Direct"; readonly uri: string }
  | { readonly _tag: "WorkspaceFile"; readonly path: string }
  | { readonly _tag: "Blocked" };

export function markdownImageSourceFragment(source: string): string {
  return splitMarkdownLinkSearchAndHash(normalizeMarkdownLinkDestination(source)).hash;
}

function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const separator = isWindowsAbsolutePath(workspaceRoot) ? "\\" : "/";
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const path = relativePath.replace(/[\\/]/g, separator).replace(/^[\\/]+/, "");
  return `${root}${separator}${path}`;
}

/**
 * Classifies a markdown image or video source by where its bytes must be loaded from.
 * Filesystem paths belong to the environment host and must never reach a
 * browser or native image component without first becoming a signed asset URL.
 */
export function classifyMarkdownImageSource(
  value: string | null | undefined,
  workspaceRoot?: string | null,
): MarkdownImageSource {
  if (value === null || value === undefined) return { _tag: "Blocked" };

  const source = normalizeMarkdownLinkDestination(value);
  if (source.length === 0 || source.startsWith("#") || source.startsWith("?")) {
    return { _tag: "Blocked" };
  }
  if (DIRECT_IMAGE_SOURCE_PATTERN.test(source)) {
    return { _tag: "Direct", uri: source };
  }

  if (/^file:/i.test(source)) {
    const target = parseFileUrlHref(source);
    return target === null
      ? { _tag: "Blocked" }
      : {
          _tag: "WorkspaceFile",
          path: stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(target.path)),
        };
  }

  const path = stripSlashPrefixedWindowsDrive(
    safeDecodeURIComponent(splitMarkdownLinkSearchAndHash(source).path),
  );
  if (path.length === 0) return { _tag: "Blocked" };
  if (path.startsWith("/") || isWindowsAbsolutePath(path)) {
    return { _tag: "WorkspaceFile", path };
  }
  if (URI_SCHEME_PATTERN.test(path) || path.startsWith("~/") || path.startsWith("~\\")) {
    return { _tag: "Blocked" };
  }
  if (!workspaceRoot) return { _tag: "Blocked" };

  return { _tag: "WorkspaceFile", path: joinWorkspacePath(workspaceRoot, path) };
}

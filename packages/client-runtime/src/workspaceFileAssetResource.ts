import type { AssetResource } from "@t3tools/contracts";
import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@t3tools/shared/filePreview";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { mediaFileReference } from "./mediaReference.ts";

function absoluteWorkspaceMediaPath(cwd: string, path: string): string {
  if (path.startsWith("/") || isWindowsAbsolutePath(path)) return path;
  if (isWindowsAbsolutePath(cwd) || cwd.startsWith("//")) {
    const separator = cwd.includes("\\") ? "\\" : "/";
    return `${cwd.replace(/[\\/]+$/, "")}${separator}${path.replace(/[\\/]/g, separator)}`;
  }
  return `${cwd.replace(/\/+$/, "")}/${path}`;
}

/** File panels carry their source checkout independently of their resource owner. */
export function workspaceFileAssetResource(input: {
  readonly cwd: string | null | undefined;
  readonly path: string | null | undefined;
}): Extract<AssetResource, { readonly _tag: "draft-workspace-file" }> | null {
  if (!input.cwd || !input.path) return null;
  return {
    _tag: "draft-workspace-file",
    cwd: input.cwd,
    // Media requires an exact absolute grant; relative HTML permits sibling assets.
    path:
      isWorkspaceVideoPreviewPath(input.path) || isWorkspaceAudioPreviewPath(input.path)
        ? absoluteWorkspaceMediaPath(input.cwd, input.path)
        : (mediaFileReference(input.path, input.cwd).relativePath ?? input.path),
  };
}

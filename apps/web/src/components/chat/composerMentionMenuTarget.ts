import { resolveDiffPathForWorkspace } from "../../diffFileActions";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  resolveFileContextMenuAbsolutePath,
  type FileContextMenuTarget,
} from "../../fileContextMenu";

/** Only live file mentions reach this path; attachments retain their captured identity. */
export function composerMentionMenuTarget(
  environmentId: EnvironmentId | null,
  workspaceRoot: string | null,
  path: string,
): FileContextMenuTarget | null {
  if (environmentId === null || workspaceRoot === null || path.trim() === "" || /[\\/]$/.test(path))
    return null;
  const filePath = resolveDiffPathForWorkspace({
    filePath: path,
    workspaceRoot,
    repositoryRoot: undefined,
  });
  if (filePath === null) return null;
  const target = { environmentId, workspaceRoot, filePath };
  return resolveFileContextMenuAbsolutePath(target) === null ? null : target;
}

/** A search hit must identify this file exactly before host actions are offered. */
export function isResolvedComposerMention(
  path: string,
  entries: readonly { readonly path: string; readonly kind: string }[],
): boolean {
  return entries.some((entry) => entry.path === path && entry.kind === "file");
}

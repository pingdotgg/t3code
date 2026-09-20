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
  const target = { environmentId, workspaceRoot, filePath: path };
  return resolveFileContextMenuAbsolutePath(target) === null ? null : target;
}

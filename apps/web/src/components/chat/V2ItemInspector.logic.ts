import type { OrchestrationV2FileChangeDetail } from "@t3tools/contracts";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";

export function formatFileChangeLine(
  change: OrchestrationV2FileChangeDetail,
  workspaceRoot: string | undefined,
): string {
  const path = formatWorkspaceRelativePath(change.path, workspaceRoot);
  const oldPath = change.oldPath
    ? `${formatWorkspaceRelativePath(change.oldPath, workspaceRoot)} → `
    : "";
  const fileType =
    change.fileType || change.mimeType
      ? ` (${[change.fileType, change.mimeType].filter(Boolean).join(", ")})`
      : "";
  return `${change.operation} ${oldPath}${path}${fileType}`;
}

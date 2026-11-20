import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import { isAbsolutePath, isWindowsAbsolutePath } from "@t3tools/shared/path";

/** Changes when the thread or a task it delegated may have changed more files, so the list asks again. */
export function threadDocumentsRevision(
  projection: Pick<ThreadStructure, "turnItems" | "subagents"> | null,
): string {
  if (projection === null) return "none";
  let changes = 0;
  let lastChangeId = "";
  for (const item of projection.turnItems) {
    if (item.type !== "file_change" || item.status !== "completed") continue;
    changes += 1;
    lastChangeId = item.id;
  }
  // A delegated task changes files in its own thread; its status here moves when it does.
  const tasks = projection.subagents
    .filter((subagent) => subagent.childThreadId !== null)
    .map((subagent) => `${subagent.childThreadId}=${subagent.status}`)
    .join(",");
  return `${changes}:${lastChangeId}:${tasks}`;
}

/** The absolute path to open, or null when a relative path has no folder to resolve against. */
export function resolveDocumentPath(path: string, workspaceRoot: string | null): string | null {
  if (isAbsolutePath(path)) return path;
  if (workspaceRoot === null) return null;
  const separator = isWindowsAbsolutePath(workspaceRoot) ? "\\" : "/";
  return `${workspaceRoot.replace(/[\\/]+$/, "")}${separator}${path.replace(/^(?:\.[\\/])+/, "")}`;
}

/** The file name, and the folder that holds it, for a row that shows the full path on hover. */
export function splitDocumentPath(path: string): {
  readonly name: string;
  readonly folder: string;
} {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return {
    name: segments.at(-1) ?? path,
    folder: segments.at(-2) ?? "",
  };
}

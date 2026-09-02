import { isWindowsAbsolutePath } from "@t3tools/shared/path";

import { isAbsolutePath } from "~/terminal-links";

export interface FileBreadcrumb {
  label: string;
  path: string;
  kind: "project" | "directory" | "file";
}

/**
 * Crumbs for a workspace-relative path start at the project. An absolute host
 * path is outside the workspace, so its crumbs start at the filesystem root.
 */
export function fileBreadcrumbs(projectName: string, relativePath: string): FileBreadcrumb[] {
  const hostPath = isAbsolutePath(relativePath);
  const separator = isWindowsAbsolutePath(relativePath) ? "\\" : "/";
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const root = relativePath.startsWith("\\\\") ? "\\\\" : hostPath && separator === "/" ? "/" : "";
  return [
    ...(hostPath ? [] : [{ label: projectName, path: "", kind: "project" as const }]),
    ...parts.map((part, index) => ({
      label: part,
      path: root + parts.slice(0, index + 1).join(separator),
      kind: index === parts.length - 1 ? ("file" as const) : ("directory" as const),
    })),
  ];
}

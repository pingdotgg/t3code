import type { ProjectEntry } from "@t3tools/contracts";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

import { isAbsolutePath } from "~/terminal-links";

export interface FileBreadcrumb {
  label: string;
  path: string;
  kind: "project" | "directory" | "file";
}

export interface FileBreadcrumbChild extends ProjectEntry {
  label: string;
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
    ...parts.map((part, index) => {
      const path = root + parts.slice(0, index + 1).join(separator);
      return {
        label: part,
        // A bare drive (`C:`) means the drive's current directory; its root is `C:\`.
        path: /^[A-Za-z]:$/.test(path) ? `${path}\\` : path,
        kind: index === parts.length - 1 ? ("file" as const) : ("directory" as const),
      };
    }),
  ];
}

/**
 * Whether a host folder crumb names a directory the server can list. A UNC
 * server (`\\server`) is not one; its shares (`\\server\share`) are.
 */
export function isListableHostFolder(path: string): boolean {
  return isAbsolutePath(path) && !/^\\\\[^\\/]+$/.test(path);
}

function comparablePath(path: string): string {
  // Host paths compare with one separator and no trailing one, except a root.
  if (!isAbsolutePath(path)) return path;
  const normalized = path.replaceAll("\\", "/");
  return normalized.replace(/(?<=[^/:])\/+$/, "");
}

/**
 * Whether `path` is `folder` or inside it. `""` is the workspace root. Workspace
 * and host paths never contain each other.
 */
function isWithinFolder(path: string, folder: string): boolean {
  const hostPath = isAbsolutePath(path);
  if (hostPath !== isAbsolutePath(folder)) return false;
  if (!hostPath) return folder === "" || path === folder || path.startsWith(`${folder}/`);
  const target = comparablePath(path);
  const base = comparablePath(folder);
  return target === base || target.startsWith(base.endsWith("/") ? base : `${base}/`);
}

/**
 * The deepest path the breadcrumbs keep showing after the browser moves to `path`.
 * Going up keeps the folders below visible so the way back down is one click;
 * moving anywhere else starts over at `path`.
 */
export function retainedBreadcrumbTrail(trail: string | undefined, path: string): string {
  return trail !== undefined && isWithinFolder(trail, path) ? trail : path;
}

/**
 * The entry of `folder` that leads toward `trail`, relative to `folder` with `/`,
 * as the folder's listing names it; null when the trail ends at the folder.
 */
export function trailChildOf(folder: string, trail: string): string | null {
  if (!isWithinFolder(trail, folder)) return null;
  const base = comparablePath(folder);
  const rest = comparablePath(trail).slice(base.length).replace(/^\/+/, "");
  return rest.split("/")[0] || null;
}

/**
 * A host path for `relativePath` (as a host folder's listing names it, with `/`)
 * inside host folder `folder`, using the folder's own separator.
 */
export function joinHostPath(folder: string, relativePath: string): string {
  const separator = isWindowsAbsolutePath(folder) ? "\\" : "/";
  const base = folder.endsWith(separator) ? folder : `${folder}${separator}`;
  return base + relativePath.split("/").join(separator);
}

export function fileBreadcrumbChildren(
  entries: readonly ProjectEntry[],
  directoryPath: string,
): FileBreadcrumbChild[] {
  let collator: Intl.Collator | undefined;
  const prefix = directoryPath ? `${directoryPath}/` : "";
  return entries
    .flatMap((entry) => {
      if (!entry.path.startsWith(prefix)) return [];
      const label = entry.path.slice(prefix.length);
      if (!label || label.includes("/")) return [];
      return [{ ...entry, label }];
    })
    .toSorted((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      collator ??= new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: "base",
      });
      return collator.compare(left.label, right.label);
    });
}

export function fileBreadcrumbParent(directoryPath: string): string | null {
  if (!directoryPath) return null;
  const separatorIndex = directoryPath.lastIndexOf("/");
  return separatorIndex === -1 ? "" : directoryPath.slice(0, separatorIndex);
}

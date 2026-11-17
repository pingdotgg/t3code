import type { ProjectEntry } from "@t3tools/contracts";
import { isWindowsAbsolutePath, isHostPath } from "@t3tools/shared/path";

export interface FileBreadcrumb {
  label: string;
  path: string;
  kind: "project" | "directory" | "file";
}

export interface FileBreadcrumbChild extends ProjectEntry {
  label: string;
}

export function fileBreadcrumbs(
  projectName: string,
  relativePath: string,
  cwd?: string,
): FileBreadcrumb[] {
  const hostPath = isHostPath(relativePath);
  const windowsPath = isWindowsAbsolutePath(relativePath);
  // Home expansion consumes the prefix; only Windows treats its remaining backslashes as separators.
  const homePath = relativePath.startsWith("~\\")
    ? "~/" +
      (isWindowsAbsolutePath(cwd ?? "")
        ? relativePath.slice(2).replaceAll("\\", "/")
        : relativePath.slice(2))
    : relativePath;
  const separator = windowsPath ? "\\" : "/";
  // `\` is a legal filename character outside Windows paths.
  const parts = homePath.split(windowsPath ? /[\\/]/ : "/").filter(Boolean);
  const root = relativePath.startsWith("\\\\") ? "\\\\" : relativePath.startsWith("/") ? "/" : "";
  return [
    ...(hostPath ? [] : [{ label: projectName, path: "", kind: "project" as const }]),
    ...parts.map((part, index) => {
      const path = root + parts.slice(0, index + 1).join(separator);
      return {
        label: part,
        // A bare drive (`C:`) means the drive's current directory; its root is `C:\`.
        // A bare `~` is not a host path; the home folder is `~/`.
        path: /^[A-Za-z]:$/.test(path) ? `${path}\\` : hostPath && path === "~" ? "~/" : path,
        kind: index === parts.length - 1 ? ("file" as const) : ("directory" as const),
      };
    }),
  ];
}

/** Use the destination's crumb spelling so trailing or repeated separators still match. */
export function breadcrumbPathOf(relativePath: string, cwd?: string): string {
  return fileBreadcrumbs("", relativePath, cwd).at(-1)?.path ?? relativePath;
}

/** UNC servers are not listable directories; their shares are. */
export function isListableHostFolder(path: string): boolean {
  return isHostPath(path) && !/^\\\\[^\\/]+$/.test(path);
}

function trailCrumbIndex(trail: string, path: string, cwd?: string): number {
  const crumbPath = breadcrumbPathOf(path, cwd);
  return fileBreadcrumbs("", trail, cwd).findIndex((crumb) => crumb.path === crumbPath);
}

/** Retain descendant crumbs when navigating up; other navigation resets the trail to path. */
export function retainedBreadcrumbTrail(
  trail: string | undefined,
  path: string,
  cwd?: string,
): string {
  return trail !== undefined && trailCrumbIndex(trail, path, cwd) >= 0 ? trail : path;
}

export function trailChildOf(folder: string, trail: string, cwd?: string): string | null {
  const index = trailCrumbIndex(trail, folder, cwd);
  return index < 0 ? null : (fileBreadcrumbs("", trail, cwd)[index + 1]?.label ?? null);
}

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

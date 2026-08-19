export interface RightPanelFileLocation {
  cwd: string;
  relativePath: string;
  rootLabel: string | null;
  workspaceRelative: boolean;
}

function normalizePath(path: string): string {
  const slashPath = path.replaceAll("\\", "/");
  const isUnc = slashPath.startsWith("//");
  const driveRoot = slashPath.match(/^[A-Za-z]:\//)?.[0];
  const root = isUnc ? "//" : driveRoot ? driveRoot : slashPath.startsWith("/") ? "/" : "";
  const protectedSegments = isUnc ? 2 : 0;
  const segments: string[] = [];

  for (const segment of slashPath.slice(root.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > protectedSegments && segments.at(-1) !== "..") {
        segments.pop();
      } else if (!root) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  return `${root}${segments.join("/")}`;
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("//");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || isWindowsAbsolutePath(path);
}

function workspaceRelativePath(path: string, workspaceRoot: string): string | null {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(workspaceRoot);
  const caseInsensitive = isWindowsAbsolutePath(path) || isWindowsAbsolutePath(workspaceRoot);
  const comparablePath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
  const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (!comparablePath.startsWith(`${comparableRoot}/`)) return null;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

function absolutePathParent(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separatorIndex === 0) return path.slice(0, 1);
  if (separatorIndex === 2 && /^[A-Za-z]:[\\/]/.test(path)) {
    return path.slice(0, 3);
  }
  return path.slice(0, separatorIndex);
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

export function resolveRightPanelFileLocation(
  workspaceRoot: string,
  filePath: string,
): RightPanelFileLocation {
  if (!isAbsolutePath(filePath)) {
    return {
      cwd: workspaceRoot,
      relativePath: filePath,
      rootLabel: null,
      workspaceRelative: true,
    };
  }

  const relativePath = workspaceRelativePath(filePath, workspaceRoot);
  if (relativePath !== null) {
    return {
      cwd: workspaceRoot,
      relativePath,
      rootLabel: null,
      workspaceRelative: true,
    };
  }

  const normalizedFilePath = normalizePath(filePath);
  const filePathWithOriginalSeparators = filePath.includes("\\")
    ? normalizedFilePath.replaceAll("/", "\\")
    : normalizedFilePath;
  const cwd = absolutePathParent(filePathWithOriginalSeparators);
  return {
    cwd,
    relativePath: basename(filePathWithOriginalSeparators),
    rootLabel: basename(cwd) || cwd,
    workspaceRelative: false,
  };
}

export function fileSurfacePathForLocation(
  location: RightPanelFileLocation,
  relativePath: string,
): string {
  if (location.workspaceRelative) return relativePath;
  const separator = location.cwd.includes("\\") ? "\\" : "/";
  const cwd = location.cwd.replace(/[\\/]+$/, "");
  const path = separator === "\\" ? relativePath.replaceAll("/", "\\") : relativePath;
  return `${cwd}${separator}${path}`;
}

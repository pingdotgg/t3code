import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
  "http:",
  "https:",
  "zed:",
  "obsidian:",
  "vscode:",
  "vscode-insiders:",
  "cursor:",
  "windsurf:",
]);

export type DesktopOpenTarget =
  | {
      kind: "path";
      value: string;
    }
  | {
      kind: "external";
      value: string;
    };

type OpenTargetResolutionOptions = {
  homeDir?: string;
  pathExists?: (path: string) => boolean;
};

function getHomeDir(options: OpenTargetResolutionOptions): string {
  return options.homeDir ?? OS.homedir();
}

function pathExists(path: string, options: OpenTargetResolutionOptions): boolean {
  return options.pathExists?.(path) ?? FS.existsSync(path);
}

export function stripLocationSuffixFromLocalPath(
  rawPath: string,
  options: OpenTargetResolutionOptions = {},
): string | null {
  const trimmedPath = rawPath.trim();
  if (trimmedPath.length === 0) {
    return null;
  }

  let normalizedPath = trimmedPath;
  if (normalizedPath === "~") {
    normalizedPath = getHomeDir(options);
  } else if (normalizedPath.startsWith("~/")) {
    normalizedPath = Path.join(getHomeDir(options), normalizedPath.slice(2));
  }

  const hashIndex = normalizedPath.indexOf("#");
  if (hashIndex !== -1) {
    normalizedPath = normalizedPath.slice(0, hashIndex);
  }

  const queryIndex = normalizedPath.indexOf("?");
  if (queryIndex !== -1) {
    normalizedPath = normalizedPath.slice(0, queryIndex);
  }

  const lineSuffixMatch = normalizedPath.match(/^(.*?)(:\d+(?::\d+)?)$/);
  const basePath = lineSuffixMatch?.[1];
  if (basePath && !pathExists(normalizedPath, options) && pathExists(basePath, options)) {
    normalizedPath = basePath;
  }

  return normalizedPath;
}

export function getSafeOpenTarget(
  rawUrl: unknown,
  options: OpenTargetResolutionOptions = {},
): DesktopOpenTarget | null {
  if (typeof rawUrl !== "string") {
    return null;
  }

  const normalizedUrl = rawUrl.trim();
  if (normalizedUrl.length === 0) {
    return null;
  }

  if (normalizedUrl.startsWith("/") || normalizedUrl === "~" || normalizedUrl.startsWith("~/")) {
    const localPath = stripLocationSuffixFromLocalPath(normalizedUrl, options);
    if (!localPath) {
      return null;
    }

    return {
      kind: "path",
      value: localPath,
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol === "file:") {
    let localPath = decodeURIComponent(parsedUrl.pathname);
    if (process.platform === "win32" && /^\/[A-Za-z]:/.test(localPath)) {
      localPath = localPath.slice(1);
    }

    const normalizedPath = stripLocationSuffixFromLocalPath(localPath, options);
    if (!normalizedPath) {
      return null;
    }

    return {
      kind: "path",
      value: normalizedPath,
    };
  }

  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsedUrl.protocol)) {
    return null;
  }

  return {
    kind: "external",
    value: parsedUrl.toString(),
  };
}

export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isExplicitRelativePath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

export function resolveT3XdgBaseDir(input: {
  readonly platform: string;
  readonly xdgHome: string | undefined;
  readonly path: {
    readonly isAbsolute: (value: string) => boolean;
    readonly join: (...paths: Array<string>) => string;
  };
}): string | undefined {
  const xdgHome = input.xdgHome?.trim();
  if (
    input.platform !== "win32" &&
    xdgHome !== undefined &&
    xdgHome.length > 0 &&
    input.path.isAbsolute(xdgHome)
  ) {
    return input.path.join(xdgHome, "t3code");
  }

  return undefined;
}

export function resolveDefaultT3BaseDir(
  input: Parameters<typeof resolveT3XdgBaseDir>[0] & {
    readonly homeDirectory: string;
  },
): string {
  return resolveT3XdgBaseDir(input) ?? input.path.join(input.homeDirectory, ".t3");
}

/**
 * Preserve an existing legacy installation until the matching XDG directory
 * has been initialized. This keeps upgrades non-destructive while still
 * making XDG the default for new installations.
 */
export function selectT3XdgDirectory(input: {
  readonly xdgDirectory: string | undefined;
  readonly legacyDirectory: string;
  readonly xdgDirectoryExists: boolean;
  readonly legacyDirectoryExists: boolean;
}): string {
  if (input.xdgDirectory === undefined) {
    return input.legacyDirectory;
  }
  if (input.xdgDirectoryExists || !input.legacyDirectoryExists) {
    return input.xdgDirectory;
  }
  return input.legacyDirectory;
}

function isRootPath(value: string): boolean {
  return value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]?$/.test(value);
}

function trimTrailingPathSeparators(value: string): string {
  if (value.length === 0 || isRootPath(value)) {
    return value;
  }
  const trimmed = value.startsWith("/")
    ? value.replace(/\/+$/g, "")
    : value.replace(/[\\/]+$/g, "");
  if (trimmed.length === 0) {
    return value;
  }
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

export function normalizeProjectPathForDispatch(value: string): string {
  return trimTrailingPathSeparators(value.trim());
}

export function normalizeProjectPathForComparison(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  if (isWindowsDrivePath(normalized) || isUncPath(normalized)) {
    return normalized.replaceAll("/", "\\").toLowerCase();
  }
  return normalized;
}

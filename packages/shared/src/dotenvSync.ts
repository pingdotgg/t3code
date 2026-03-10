const MAX_DOTENV_SYNC_PATHS = 16;
const MAX_DOTENV_SYNC_PATH_LENGTH = 512;

function normalizeSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

function collapseRelativeSegments(value: string): string | null {
  const normalized = normalizeSeparators(value);
  const segments = normalized.split("/");
  const resolved: string[] = [];

  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    resolved.push(segment);
  }

  return resolved.join("/");
}

export interface NormalizeDotenvSyncPathResult {
  normalizedPath: string | null;
  error: string | null;
}

export function normalizeDotenvSyncPath(input: string): NormalizeDotenvSyncPathResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { normalizedPath: null, error: "Path is required." };
  }
  if (trimmed.length > MAX_DOTENV_SYNC_PATH_LENGTH) {
    return {
      normalizedPath: null,
      error: `Path must be ${MAX_DOTENV_SYNC_PATH_LENGTH} characters or less.`,
    };
  }

  const normalized = normalizeSeparators(trimmed);
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")) {
    return { normalizedPath: null, error: "Path must be relative to the project root." };
  }

  const collapsed = collapseRelativeSegments(normalized);
  if (!collapsed) {
    return { normalizedPath: null, error: "Path must stay within the project root." };
  }

  const fileName = collapsed.split("/").at(-1) ?? "";
  if (!fileName.startsWith(".env")) {
    return { normalizedPath: null, error: "Path must point to a dotenv file." };
  }

  return { normalizedPath: collapsed, error: null };
}

export function normalizeDotenvSyncPaths(
  paths: Iterable<string | null | undefined>,
): NormalizeDotenvSyncPathResult & { normalizedPaths: string[] } {
  const normalizedPaths: string[] = [];
  const seen = new Set<string>();

  for (const candidate of paths) {
    const result = normalizeDotenvSyncPath(candidate ?? "");
    if (!result.normalizedPath) {
      return {
        normalizedPath: null,
        normalizedPaths: [],
        error: result.error,
      };
    }
    if (seen.has(result.normalizedPath)) {
      return {
        normalizedPath: null,
        normalizedPaths: [],
        error: `Duplicate dotenv path: ${result.normalizedPath}`,
      };
    }
    seen.add(result.normalizedPath);
    normalizedPaths.push(result.normalizedPath);
    if (normalizedPaths.length > MAX_DOTENV_SYNC_PATHS) {
      return {
        normalizedPath: null,
        normalizedPaths: [],
        error: `You can sync up to ${MAX_DOTENV_SYNC_PATHS} dotenv files.`,
      };
    }
  }

  return {
    normalizedPath: normalizedPaths[0] ?? null,
    normalizedPaths,
    error: null,
  };
}

export { MAX_DOTENV_SYNC_PATH_LENGTH, MAX_DOTENV_SYNC_PATHS };

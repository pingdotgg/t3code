const APPIMAGE_RUNTIME_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
// ld.so also splits LD_LIBRARY_PATH on semicolons.
const APPIMAGE_PATH_LIKE_ENV_SEPARATORS = {
  PATH: /:/,
  LD_LIBRARY_PATH: /[:;]/,
  XDG_DATA_DIRS: /:/,
  GSETTINGS_SCHEMA_DIR: /:/,
} as const;

interface NormalizedPosixPath {
  readonly absolute: boolean;
  readonly parts: readonly string[];
}

function normalizePosixPath(value: string): NormalizedPosixPath {
  return {
    absolute: value.startsWith("/"),
    parts: value.split("/").filter((part) => part !== "" && part !== "."),
  };
}

function isPathSegmentUnderAppDir(segment: string, appDir: NormalizedPosixPath): boolean {
  const normalized = normalizePosixPath(segment);
  // Where ".." lands depends on symlinks, so such an entry may point outside the mount; keep it.
  if (
    normalized.absolute !== appDir.absolute ||
    normalized.parts.length < appDir.parts.length ||
    normalized.parts.includes("..")
  ) {
    return false;
  }
  return appDir.parts.every((part, index) => normalized.parts[index] === part);
}

// AppImage mount paths would make child commands resolve against the mount instead of the user's system.
export function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;

  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete scrubbed[key];
  }

  const appDir = env.APPDIR ? normalizePosixPath(env.APPDIR) : undefined;
  if (appDir && appDir.parts.length > 0) {
    for (const [key, separator] of Object.entries(APPIMAGE_PATH_LIKE_ENV_SEPARATORS)) {
      const value = scrubbed[key];
      if (value === undefined) continue;
      const segments = value.split(separator);
      const kept = segments.filter((segment) => !isPathSegmentUnderAppDir(segment, appDir));
      if (kept.length === segments.length) continue;
      if (kept.length === 0) {
        delete scrubbed[key];
      } else {
        // Empty entries mean the current directory; a lone one must stay ":" since "" means none.
        scrubbed[key] = kept.length === 1 && kept[0] === "" ? ":" : kept.join(":");
      }
    }
  }

  return scrubbed;
}

const APPIMAGE_RUNTIME_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
// ld.so also splits LD_LIBRARY_PATH on semicolons.
const APPIMAGE_PATH_LIKE_ENV_SEPARATORS = {
  PATH: /:/,
  LD_LIBRARY_PATH: /[:;]/,
  XDG_DATA_DIRS: /:/,
  GSETTINGS_SCHEMA_DIR: /:/,
} as const;

function isPathSegmentUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

// AppImage mount paths would make child commands resolve against the mount instead of the user's system.
export function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;

  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete scrubbed[key];
  }

  const appDir = env.APPDIR?.replace(/\/+$/, "");
  if (appDir) {
    for (const [key, separator] of Object.entries(APPIMAGE_PATH_LIKE_ENV_SEPARATORS)) {
      const value = scrubbed[key];
      if (value === undefined) continue;
      // Empty entries mean the current directory, so they stay unless nothing else does.
      const kept = value
        .split(separator)
        .filter((segment) => !isPathSegmentUnderAppDir(segment, appDir));
      if (kept.some((segment) => segment.length > 0)) {
        scrubbed[key] = kept.join(":");
      } else {
        delete scrubbed[key];
      }
    }
  }

  return scrubbed;
}

// Kept free of runtime imports: the service launcher must work even when the
// selected server version cannot load its dependencies.
export const SERVICE_PATH_ENV = "T3_SERVICE_PATH";
export const SERVICE_WSL_DISTRO_ENV = "T3_SERVICE_WSL_DISTRO_NAME";

/** Merge POSIX service paths in priority order without introducing cwd entries. */
export function mergeServicePaths(...paths: ReadonlyArray<string | undefined>): string {
  return Array.from(
    new Set(paths.flatMap((path) => (path ?? "").split(":")).filter((entry) => entry.length > 0)),
  ).join(":");
}

/** Installer values supplement the service manager's environment at each spawn. */
export function resolveServiceEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    ...(env[SERVICE_PATH_ENV] ? { PATH: mergeServicePaths(env.PATH, env[SERVICE_PATH_ENV]) } : {}),
    ...(!env.WSL_DISTRO_NAME?.trim() && env[SERVICE_WSL_DISTRO_ENV]?.trim()
      ? { WSL_DISTRO_NAME: env[SERVICE_WSL_DISTRO_ENV] }
      : {}),
  };
}

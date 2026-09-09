const POSTFIX_REGEX = /[?#].*$/;

export function sanitizePath(path: string): string {
  return path.replace(POSTFIX_REGEX, "");
}

/**
 * Normalizes a path to use forward slashes. This ensures paths are valid
 * module specifiers and produce consistent output across platforms (e.g. Windows,
 * where `path` APIs return backslash-separated paths).
 */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function hasNodejsCompat(flags?: ReadonlyArray<string>): boolean {
  return (
    flags?.some(
      (flag) => flag === "nodejs_compat" || flag === "nodejs_compat_v2",
    ) ?? false
  );
}

export function hasNodejsAls(flags?: ReadonlyArray<string>): boolean {
  return flags?.some((flag) => flag === "nodejs_als") ?? false;
}

export function resolvePluginApi<Api>(
  plugins: ReadonlyArray<unknown>,
  name: string,
) {
  return plugins.find(
    (plugin): plugin is { name: string; api: Api } =>
      typeof plugin === "object" &&
      plugin !== null &&
      "name" in plugin &&
      plugin.name === name,
  )?.api;
}

export function resolveWindowsCommandShell(env: NodeJS.ProcessEnv): string {
  return env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
}

export function isWindowsCommandNotFound(
  code: number | null,
  stderr: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  if (code === 9009) return true;
  return /is not recognized as an internal or external command/i.test(stderr);
}

export function isWindowsBatchShim(filePath: string): boolean {
  return /\.(cmd|bat)$/i.test(filePath);
}

export function quoteForWindowsCmd(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

export function makeWindowsCmdCommandLine(
  commandPath: string,
  args: ReadonlyArray<string>,
): string {
  return `"${[commandPath, ...args].map(quoteForWindowsCmd).join(" ")}"`;
}

export function makeWindowsCmdSpawnArguments(
  commandPath: string,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return ["/d", "/v:off", "/s", "/c", makeWindowsCmdCommandLine(commandPath, args)];
}

export interface ResolvedShellCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly shell: boolean;
}

export function isWindowsUncPath(
  cwd: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32" || !cwd) {
    return false;
  }

  return /^[/\\]{2}/.test(cwd);
}

function quoteForCmd(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function buildWindowsUncCommand(command: string, args: ReadonlyArray<string>, cwd: string): string {
  const commandLine = [command, ...args].map(quoteForCmd).join(" ");
  return `pushd ${quoteForCmd(cwd)} && (${commandLine} & set "T3CODE_EXIT_CODE=!ERRORLEVEL!" & popd & exit /b !T3CODE_EXIT_CODE!)`;
}

export function resolveShellCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly platform?: NodeJS.Platform;
  } = {},
): ResolvedShellCommand {
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd;

  if (isWindowsUncPath(cwd, platform)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/v:on", "/s", "/c", buildWindowsUncCommand(command, args, cwd)],
      cwd: undefined,
      shell: false,
    };
  }

  return {
    command,
    args,
    cwd,
    shell: platform === "win32",
  };
}

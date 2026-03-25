export interface ResolvedShellCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env?: Readonly<Record<string, string>>;
  readonly shell: boolean;
}

export function isWindowsUncPath(
  cwd: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32" || !cwd) {
    return false;
  }

  return /^[/\\]{2}(?!\?\\)/.test(cwd);
}

function quoteForCmd(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isBatchScriptCommand(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command);
}

const WINDOWS_UNC_ENV_PREFIX = "__T3CODE_WINDOWS_UNC";

function buildWindowsUncCommand(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): {
  readonly script: string;
  readonly env: Readonly<Record<string, string>>;
} {
  const env: Record<string, string> = {
    [`${WINDOWS_UNC_ENV_PREFIX}_CWD`]: quoteForCmd(cwd),
    [`${WINDOWS_UNC_ENV_PREFIX}_COMMAND`]: quoteForCmd(command),
  };
  const argRefs = args.map((arg, index) => {
    const key = `${WINDOWS_UNC_ENV_PREFIX}_ARG_${index}`;
    env[key] = quoteForCmd(arg);
    return `%${key}%`;
  });
  const commandRef = `%${WINDOWS_UNC_ENV_PREFIX}_COMMAND%`;
  const cwdRef = `%${WINDOWS_UNC_ENV_PREFIX}_CWD%`;
  const commandPrefix = isBatchScriptCommand(command) ? "call " : "";
  return {
    script: `pushd ${cwdRef} && ${commandPrefix}${commandRef}${argRefs.length > 0 ? ` ${argRefs.join(" ")}` : ""}`,
    env,
  };
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
    const wrappedCommand = buildWindowsUncCommand(command, args, cwd);
    return {
      command: "cmd.exe",
      args: ["/d", "/c", wrappedCommand.script],
      cwd: undefined,
      env: wrappedCommand.env,
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

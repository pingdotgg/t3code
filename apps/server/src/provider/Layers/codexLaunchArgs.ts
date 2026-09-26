import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export type CodexLaunchArgs = ReadonlyArray<string>;

const MAX_CODEX_LAUNCH_ARGS_LENGTH = 16_384;
const MAX_CODEX_LAUNCH_ARG_COUNT = 256;
const SAFE_ARGUMENT = /^[A-Za-z0-9_./:@%+=,-]+$/u;

export const parseCodexLaunchArgs = (value: string): CodexLaunchArgs => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  if (
    trimmed.length > MAX_CODEX_LAUNCH_ARGS_LENGTH ||
    trimmed.includes("\0") ||
    trimmed.includes("\r") ||
    trimmed.includes("\n") ||
    trimmed.endsWith("\\")
  ) {
    throw new Error("invalid Codex launch arguments");
  }
  const args = tokenizeCliArgs(trimmed);
  if (args.length > MAX_CODEX_LAUNCH_ARG_COUNT) {
    throw new Error("too many Codex launch arguments");
  }
  return args;
};

const serializeCodexLaunchArgs = (args: CodexLaunchArgs): string =>
  args.map((arg) => (SAFE_ARGUMENT.test(arg) ? arg : JSON.stringify(arg))).join(" ");

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environmentLaunchArgs?: CodexLaunchArgs,
): string => {
  const args =
    environmentLaunchArgs ?? (launchArgs === undefined ? [] : parseCodexLaunchArgs(launchArgs));
  return serializeCodexLaunchArgs(args);
};

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
};

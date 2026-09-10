import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import type { RuntimeMode } from "@t3tools/contracts";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

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
  runtimeMode?: RuntimeMode,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  const configuredArgs = appServerArgs
    ? [...launchAppServerArgs, ...appServerArgs]
    : launchAppServerArgs;

  // The per-thread protocol fields are the primary runtime contract, but the
  // Codex app-server can also inherit restrictive approval/sandbox settings
  // from CODEX_HOME or project config before a thread is opened. Force the
  // automation contract at the process boundary as well so a T3 session
  // cannot silently inherit a different approval or sandbox posture.
  const enforcedConfig =
    runtimeMode === "full-access"
      ? ['approval_policy="never"', 'sandbox_mode="danger-full-access"']
      : runtimeMode === "automated-review"
        ? ['approval_policy="never"', 'sandbox_mode="read-only"']
        : [];
  return enforcedConfig.length === 0
    ? configuredArgs
    : [...configuredArgs, "-c", enforcedConfig[0]!, "-c", enforcedConfig[1]!];
};

import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

export const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> =>
  tokenizeCliArgs(launchArgs);

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

/** TOML bare keys; anything else has to be quoted inside the dotted path. */
const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Override args that switch off MCP servers the user disabled in T3 Code.
 * Codex honours `mcp_servers.<name>.enabled` from config, and `-c` overrides
 * apply on top of `config.toml`, so nothing on disk is rewritten.
 */
export const codexMcpDisableArgs = (
  disabledMcpServers: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  disabledMcpServers.flatMap((rawName) => {
    const name = rawName.trim();
    if (name.length === 0) return [];
    const key = BARE_TOML_KEY.test(name) ? name : JSON.stringify(name);
    return ["-c", `mcp_servers.${key}.enabled=false`];
  });

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
};

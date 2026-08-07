import * as NodeOS from "node:os";

import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { parse as parseToml } from "smol-toml";

import { expandHomePath } from "../../pathExpansion.ts";

export const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";
export const T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV = "T3CODE_CODEX_APPEND_LAUNCH_ARGS";
export const T3CODE_CODEX_CUA_LAUNCH_ARGS_ENV = "T3CODE_CODEX_CUA_LAUNCH_ARGS";

export type CodexLaunchArgs = string | ReadonlyArray<string> | undefined;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsedConfigHasCuaDriver = (config: unknown): boolean => {
  if (!isRecord(config)) return false;
  const mcpServers = config.mcp_servers;
  return isRecord(mcpServers) && Object.hasOwn(mcpServers, "cua-driver");
};

const configOverrideHasCuaDriver = (override: string): boolean => {
  const assignmentIndex = override.indexOf("=");
  const key = (assignmentIndex === -1 ? override : override.slice(0, assignmentIndex)).trim();
  if (/^mcp_servers\.(?:cua-driver|"cua-driver"|'cua-driver')(?:\.|$)/.test(key)) {
    return true;
  }
  try {
    return parsedConfigHasCuaDriver(parseToml(override));
  } catch {
    return false;
  }
};

const launchArgsHaveCuaDriver = (launchArgs: CodexLaunchArgs): boolean => {
  const args = codexLaunchArgv(launchArgs);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === undefined) continue;

    if (argument === "-c" || argument === "--config") {
      const override = args[index + 1];
      if (override !== undefined && configOverrideHasCuaDriver(override)) return true;
      index++;
      continue;
    }

    if (argument.startsWith("-c=") || argument.startsWith("--config=")) {
      const override = argument.slice(argument.indexOf("=") + 1);
      if (configOverrideHasCuaDriver(override)) return true;
    }
  }
  return false;
};

export const hasConfiguredCuaDriver = (
  launchArgs: CodexLaunchArgs,
  configToml: string | undefined,
): boolean => {
  if (launchArgsHaveCuaDriver(launchArgs)) return true;
  if (configToml === undefined) return false;
  try {
    return parsedConfigHasCuaDriver(parseToml(configToml));
  } catch {
    return false;
  }
};

export const readCodexConfigToml = (
  environment: NodeJS.ProcessEnv,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<string | undefined> => {
  if (!environment[T3CODE_CODEX_CUA_LAUNCH_ARGS_ENV]?.trim()) {
    return Effect.succeed(undefined);
  }
  const configuredHome = environment.CODEX_HOME?.trim();
  const homePath = configuredHome
    ? expandHomePath(configuredHome)
    : path.join(NodeOS.homedir(), ".codex");
  return fileSystem
    .readFileString(path.join(homePath, "config.toml"))
    .pipe(Effect.orElseSucceed(() => undefined));
};

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: { readonly configToml?: string | undefined } = {},
) => {
  const configured = environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";
  const appended = environment[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV]?.trim() || "";
  const cuaLaunchArgs = environment[T3CODE_CODEX_CUA_LAUNCH_ARGS_ENV]?.trim() || "";
  const configuredArgv = tokenizeCliArgs(configured);
  const appendedArgv = tokenizeCliArgs(appended);
  const existingCuaDriver =
    cuaLaunchArgs.length > 0 &&
    hasConfiguredCuaDriver([...configuredArgv, ...appendedArgv], options.configToml);
  return [
    ...configuredArgv,
    ...appendedArgv,
    ...(existingCuaDriver ? [] : tokenizeCliArgs(cuaLaunchArgs)),
  ];
};

export const codexLaunchArgv = (launchArgs: CodexLaunchArgs): ReadonlyArray<string> =>
  typeof launchArgs === "string" ? tokenizeCliArgs(launchArgs) : (launchArgs ?? []);

export const codexAppServerArgs = (launchArgs: CodexLaunchArgs) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs: CodexLaunchArgs) => {
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
  launchArgs: CodexLaunchArgs,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
};

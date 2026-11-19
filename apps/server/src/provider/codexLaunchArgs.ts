import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { tomlStringValue } from "./codexSqliteHomeSetting.ts";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

/** Set by `codexHomeEnvironment` for a Windows shadow home: the SQLite directory T3 validated. */
export const CODEX_PINNED_SQLITE_HOME_ENV = "T3CODE_CODEX_SQLITE_HOME";

// Codex ranks `sqlite_home` from any config.toml above CODEX_SQLITE_HOME, and a later `-c` above
// both, so this goes after the launch args.
const pinnedSqliteHomeArgs = (environment: NodeJS.ProcessEnv | undefined) => {
  const sqliteHome = environment?.[CODEX_PINNED_SQLITE_HOME_ENV];
  if (!sqliteHome) return [];
  // A TOML literal string takes a Windows path as written, but cannot hold an apostrophe.
  const value = sqliteHome.includes("'") ? JSON.stringify(sqliteHome) : `'${sqliteHome}'`;
  return ["-c", `sqlite_home=${value}`];
};

const CONFIG_OVERRIDE_FLAG = /^(?:--config=|-c=?)/u;
const QUOTED_OVERRIDE_KEY = /^(["'])(.*)\1$/u;

/**
 * The launch arg that sets `sqlite_home`. Codex splits an override at its first `=` and reads only
 * the root key, so `mcp_servers.x.env.sqlite_home` and a value that mentions the key do not count.
 */
export const codexLaunchArgSettingSqliteHome = (launchArgs?: string) =>
  codexLaunchArgv(launchArgs).find((arg) => {
    // Either the flag with its override attached, or the override that follows a bare flag.
    const override = arg.replace(CONFIG_OVERRIDE_FLAG, "");
    const equals = override.indexOf("=");
    if (equals < 0) return false;
    const key = override.slice(0, equals).trim();
    return key.replace(QUOTED_OVERRIDE_KEY, "$2").trim() === "sqlite_home";
  });

/** The directory a `sqlite_home` override names: Codex reads it as TOML, or as written when that fails. */
export const codexLaunchArgSqliteHome = (arg: string) => {
  const override = arg.replace(CONFIG_OVERRIDE_FLAG, "");
  const value = override.slice(override.indexOf("=") + 1).trim();
  return tomlStringValue(value) ?? (/^["']/u.test(value) ? undefined : value);
};

// T3 unsubscribes only when it unloads a thread; Codex's own unload delay would stack on that.
export const codexAppServerArgs = (
  launchArgs: string | undefined,
  environment: NodeJS.ProcessEnv | undefined,
) => [
  "app-server",
  "-c",
  "thread_unload_delay_secs=0",
  ...codexLaunchArgv(launchArgs),
  ...pinnedSqliteHomeArgs(environment),
];

interface LaunchArgFilter {
  readonly switches: ReadonlySet<string>;
  readonly valueFlags: ReadonlySet<string>;
  readonly inlinePrefixes: ReadonlyArray<string>;
}

const SHARED_VALUE_FLAGS = ["--config", "-c", "--enable", "--disable"];
const SHARED_INLINE_PREFIXES = ["--config=", "-c=", "--enable=", "--disable="];

const MCP_LIST_FILTER: LaunchArgFilter = {
  switches: new Set(),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--profile=", "-p="],
};

const EXEC_FILTER: LaunchArgFilter = {
  switches: new Set(["--strict-config", "--oss"]),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--local-provider", "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--local-provider=", "--profile=", "-p="],
};

const filterLaunchArgs = (launchArgs: string | undefined, allowed: LaunchArgFilter) => {
  const args = codexLaunchArgv(launchArgs);
  const kept: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (allowed.switches.has(arg)) {
      kept.push(arg);
    } else if (allowed.valueFlags.has(arg)) {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        kept.push(arg, value);
        index++;
      }
    } else if (allowed.inlinePrefixes.some((prefix) => arg.startsWith(prefix))) {
      kept.push(arg);
    }
  }

  return kept;
};

const HOOK_FEATURES = new Set(["hooks", "codex_hooks"]);

// Feature toggles beat config overrides, so a launch arg's hook enable would undo ours.
export const codexExecLaunchArgs = (
  launchArgs: string | undefined,
  environment: NodeJS.ProcessEnv | undefined,
) => {
  const args = filterLaunchArgs(launchArgs, EXEC_FILTER);
  return [
    ...args.filter((arg, index) => {
      if (arg.startsWith("--enable=")) return !HOOK_FEATURES.has(arg.slice("--enable=".length));
      if (arg === "--enable") return !HOOK_FEATURES.has(args[index + 1] ?? "");
      return !(args[index - 1] === "--enable" && HOOK_FEATURES.has(arg));
    }),
    ...pinnedSqliteHomeArgs(environment),
  ];
};

export const codexMcpListLaunchArgs = (
  launchArgs: string | undefined,
  environment: NodeJS.ProcessEnv | undefined,
) => [...filterLaunchArgs(launchArgs, MCP_LIST_FILTER), ...pinnedSqliteHomeArgs(environment)];

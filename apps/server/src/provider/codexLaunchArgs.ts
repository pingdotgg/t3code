import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const override = environment[T3CODE_CODEX_LAUNCH_ARGS_ENV];
  return override?.trim() ? override : launchArgs?.trim() || "";
};

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexUsesStrictConfig = (launchArgs?: string) =>
  codexLaunchArgv(launchArgs).includes("--strict-config");

export const codexAppServerArgs = (launchArgs?: string, strictConfigVersion?: string | null) => {
  const args = codexLaunchArgv(launchArgs);
  // Strict config rejects this key before Codex 0.154. Leave unknown versions untouched.
  const setUnloadDelay =
    !args.includes("--strict-config") ||
    (strictConfigVersion != null &&
      parseSemver(strictConfigVersion) !== null &&
      compareSemverVersions(strictConfigVersion, "0.154.0") >= 0);
  return ["app-server", ...(setUnloadDelay ? ["-c", "thread_unload_delay_secs=0"] : []), ...args];
};

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
    const rawArg = args[index];
    if (rawArg === undefined) continue;
    const arg = rawArg.replace(/^(-[cp])(?=[^=])/u, "$1=");

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

const MCP_LIST_DISABLED_FEATURES = new Set(["apps", "connectors", "plugins"]);
const EXEC_DISABLED_FEATURES = new Set([...MCP_LIST_DISABLED_FEATURES, "hooks", "codex_hooks"]);

// Codex can apply explicit --enable flags after trailing -c overrides.
const omitFeatureEnables = (args: ReadonlyArray<string>, features: ReadonlySet<string>) =>
  args.filter((arg, index) => {
    if (arg.startsWith("--enable=")) return !features.has(arg.slice("--enable=".length));
    if (arg === "--enable") return !features.has(args[index + 1] ?? "");
    return !(args[index - 1] === "--enable" && features.has(arg));
  });

export const codexExecLaunchArgs = (launchArgs?: string) =>
  omitFeatureEnables(filterLaunchArgs(launchArgs, EXEC_FILTER), EXEC_DISABLED_FEATURES);

export const codexMcpListLaunchArgs = (launchArgs?: string) =>
  omitFeatureEnables(filterLaunchArgs(launchArgs, MCP_LIST_FILTER), MCP_LIST_DISABLED_FEATURES);

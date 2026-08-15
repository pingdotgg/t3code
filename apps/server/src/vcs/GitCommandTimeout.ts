export const GIT_COMMAND_TIMEOUT_MS = {
  local: 30_000,
  network: 5 * 60_000,
  commit: 10 * 60_000,
} as const;

const NETWORK_GIT_SUBCOMMANDS = new Set(["fetch", "pull", "push"]);
const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-c",
  "--config-env",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

function gitSubcommand(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUES.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

export function resolveGitCommandTimeoutMs(args: readonly string[], timeoutMs?: number): number {
  if (timeoutMs !== undefined) return timeoutMs;
  const subcommand = gitSubcommand(args);
  if (subcommand === "commit") return GIT_COMMAND_TIMEOUT_MS.commit;
  if (NETWORK_GIT_SUBCOMMANDS.has(subcommand ?? "")) return GIT_COMMAND_TIMEOUT_MS.network;
  return GIT_COMMAND_TIMEOUT_MS.local;
}

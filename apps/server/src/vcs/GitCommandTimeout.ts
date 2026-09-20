export const GIT_COMMAND_TIMEOUT_MS = {
  local: 30_000,
  network: 5 * 60_000,
  commit: 10 * 60_000,
} as const;

export type GitCommandTimeoutOverride = number | null;
export type GitCommandTimeoutInput = GitCommandTimeoutOverride | undefined;
type ResolvedGitCommandTimeout<Input extends GitCommandTimeoutInput> = Input extends null
  ? null
  : number;

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

export function resolveGitCommandTimeoutMs<Input extends GitCommandTimeoutInput = undefined>(
  args: readonly string[],
  timeoutMs?: Input,
): ResolvedGitCommandTimeout<Input> {
  if (timeoutMs !== undefined) return timeoutMs as ResolvedGitCommandTimeout<Input>;
  const subcommand = gitSubcommand(args);
  const resolved =
    subcommand === "commit"
      ? GIT_COMMAND_TIMEOUT_MS.commit
      : NETWORK_GIT_SUBCOMMANDS.has(subcommand ?? "")
        ? GIT_COMMAND_TIMEOUT_MS.network
        : GIT_COMMAND_TIMEOUT_MS.local;
  return resolved as ResolvedGitCommandTimeout<Input>;
}

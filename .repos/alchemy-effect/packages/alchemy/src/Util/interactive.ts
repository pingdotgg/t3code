import * as Effect from "effect/Effect";

/**
 * Returns true when the current process looks like it's being driven by a
 * coding agent, CI runner, test runner, or anything else that won't render an
 * interactive TUI / prompt well.
 *
 * This is the process-level source of truth used by CliKit capability
 * detection, auth configuration guards, and spawned-command stdin policy.
 *
 * Kept in `Util` (rather than `Cli`) so `Auth` can depend on it without
 * pulling in the CLI layer.
 */
// An explicit CLI flag beats every env-based heuristic. Checked via argv
// because capability detection runs while the CLI's service layers are
// built, before the command parser has produced flag values. Only scan up
// to a `--` separator so a positional argument that happens to be the
// literal text "--no-input" is not mistaken for the flag.
const hasNoInputFlag = (): boolean => {
  const separator = process.argv.indexOf("--");
  const flagArgs =
    separator === -1 ? process.argv : process.argv.slice(0, separator);
  return flagArgs.includes("--no-input");
};

// Known coding-agent env vars, ported from unjs/std-env (src/agents.ts).
// Best-effort — the isTTY checks at the call sites already catch most cases
// since agents typically pipe stdin/stdout. std-env's kiro check
// (TERM_PROGRAM=kiro gated on no-TTY) is deliberately omitted: both call
// sites only reach this function when stdin/stdout ARE a TTY, where that
// check would never match.
const isAgentEnv = (env: NodeJS.ProcessEnv): boolean =>
  !!(
    // explicit override supported by std-env
    env.AI_AGENT ||
    // claude
    env.CLAUDECODE ||
    env.CLAUDE_CODE ||
    env.CLAUDE_CODE_ENTRYPOINT ||
    // replit
    env.REPL_ID ||
    // gemini
    env.GEMINI_CLI ||
    // codex
    env.CODEX_SANDBOX ||
    env.CODEX_THREAD_ID ||
    env.CODEX_CLI ||
    // opencode
    env.OPENCODE ||
    // auggie
    env.AUGMENT_AGENT ||
    // goose
    env.GOOSE_PROVIDER ||
    // junie
    env.JUNIE_DATA ||
    env.JUNIE_SHIM_PATH ||
    // aider
    env.AIDER_MODEL ||
    // pi
    /\.pi[\\/]agent/.test(env.PATH ?? "") ||
    // devin
    /devin/.test(env.EDITOR ?? "") ||
    // cursor
    env.CURSOR_AGENT
  );

export const isNonInteractive = (): boolean => {
  const env = process.env;
  if (hasNoInputFlag()) return true;
  if (env.ALCHEMY_PLAIN === "1" || env.ALCHEMY_NO_TUI === "1") return true;
  if (env.ALCHEMY_TUI === "1") return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true;
  if (env.CI) return true;
  if (isAgentEnv(env)) return true;
  return false;
};

/**
 * Whether a plain line-based prompt can still read an answer from stdin.
 *
 * Distinct from {@link isNonInteractive}: `ALCHEMY_PLAIN` / `ALCHEMY_NO_TUI`
 * turn off the TUI *rendering*, not input — a human running plain mode in a
 * terminal can still answer a `[y/n]` question. Agents and CI pipe stdin
 * (or set their env markers) and land `false`.
 */
export const canPromptOnStdin = (): boolean => {
  const env = process.env;
  if (hasNoInputFlag()) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (env.CI) return false;
  if (isAgentEnv(env)) return false;
  return true;
};

export interface InteractionCapabilities {
  readonly input: boolean;
}

/** Process capabilities as an Effect so callers can replace them in tests. */
export const processInteractionCapabilities: Effect.Effect<InteractionCapabilities> =
  Effect.sync(() => ({ input: !isNonInteractive() }));

/** Select user-facing copy from an injected capability Effect. */
export const messageForCapabilities = <E, R>(
  capabilities: Effect.Effect<InteractionCapabilities, E, R>,
  interactive: string,
  nonInteractive: string,
): Effect.Effect<string, E, R> =>
  Effect.map(capabilities, ({ input }) =>
    input ? interactive : nonInteractive,
  );

/** Prefer the profile dashboard when this process can own a TUI screen. */
export const profileCommandHint = (nonInteractiveCommand: string) =>
  messageForCapabilities(
    processInteractionCapabilities,
    "alchemy profile",
    nonInteractiveCommand,
  );

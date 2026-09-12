/**
 * commandCodeLaunchArgs — argv builders for headless Command Code runs.
 *
 * Command Code's print mode (`-p`) never shows interactive prompts, so the
 * permission policy is a launch flag, not a runtime conversation: without
 * `--yolo` the CLI hard-blocks file writes and shell commands with a
 * `tool_hook_blocked` frame even under `--permission-mode auto-accept`.
 *
 * @module provider/commandCodeLaunchArgs
 */
import type { CommandCodePermissionMode } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export const COMMAND_CODE_VERSION_ARGS = ["--version"] as const;
export const COMMAND_CODE_LIST_MODELS_ARGS = ["--list-models"] as const;

export interface CommandCodeTurnArgsInput {
  readonly permissionMode: CommandCodePermissionMode;
  /** Model slug. Omitted when blank so the CLI uses its own persisted default. */
  readonly model?: string | undefined;
  /** Command Code headless session id, used to carry context between turns. */
  readonly resumeSessionId?: string | undefined;
  /** Extra user-provided CLI arguments, tokenized. */
  readonly launchArgs?: string | undefined;
}

/**
 * Build the argv for one headless turn. The prompt itself is always piped
 * over stdin (Command Code auto-detects piped input when no query argument
 * is present) so long prompts never hit argv length limits.
 */
export function commandCodeTurnArgs(input: CommandCodeTurnArgsInput): ReadonlyArray<string> {
  const args: string[] = ["-p", "--output-format", "json", "--skip-onboarding"];
  if (input.permissionMode === "auto-accept") {
    args.push("--yolo");
  }
  if (input.model !== undefined && input.model.trim().length > 0) {
    args.push("--model", input.model.trim());
  }
  if (input.resumeSessionId !== undefined && input.resumeSessionId.trim().length > 0) {
    args.push("--resume", input.resumeSessionId.trim());
  }
  args.push(...tokenizeCliArgs(input.launchArgs));
  return args;
}

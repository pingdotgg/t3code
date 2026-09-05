export type ClaudeRecordingQueryMode =
  | "streaming"
  | "restart"
  | "resume_at_cursor"
  | "fork_session"
  | "fork_session_prior_turn"
  | "fork_session_continue"
  | "fork_session_siblings"
  | "fork_session_merge_back"
  | "fork_session_merge_back_siblings"
  | "active_steering"
  | "interrupt"
  | "interrupt_restart";

export function validateClaudeReplayRecordingSelection(input: {
  readonly scenario: string;
  readonly configuredQueryMode: ClaudeRecordingQueryMode;
  readonly selectedQueryMode: ClaudeRecordingQueryMode;
  readonly configuredPromptCount: number;
  readonly selectedPromptCount: number;
}): void {
  if (input.selectedQueryMode !== input.configuredQueryMode) {
    throw new Error(
      `Claude replay fixture '${input.scenario}' uses query mode '${input.configuredQueryMode}', not '${input.selectedQueryMode}'. Select a scenario configured for the requested query mode.`,
    );
  }
  if (input.selectedPromptCount !== input.configuredPromptCount) {
    throw new Error(
      `Claude replay fixture '${input.scenario}' requires exactly ${input.configuredPromptCount} prompt(s) for query mode '${input.configuredQueryMode}', but received ${input.selectedPromptCount}.`,
    );
  }
}

const SEEDED_CURSOR_REPLAY_SCENARIOS = new Set(["subagent", "tool_call_read_only", "todo_list"]);

export function cursorReplayPromptsForWorkspace(input: {
  readonly scenario: string;
  readonly configuredPrompts: ReadonlyArray<string>;
  readonly packageJsonPath: string;
  readonly tsconfigPath: string;
}): ReadonlyArray<string> {
  if (input.scenario !== "tool_call_read_only") {
    return input.configuredPrompts;
  }

  return [
    `Read ${input.packageJsonPath} and ${input.tsconfigPath}, then answer exactly: read only tool fixture complete`,
  ];
}

export function shouldSeedCursorReplayWorkspace(input: {
  readonly scenario: string;
  readonly owned: boolean;
}): boolean {
  return input.owned && SEEDED_CURSOR_REPLAY_SCENARIOS.has(input.scenario);
}

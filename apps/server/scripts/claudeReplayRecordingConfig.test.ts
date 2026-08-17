import { assert, it } from "@effect/vitest";

import { validateClaudeReplayRecordingSelection } from "./claudeReplayRecordingConfig.ts";

it("rejects a query mode that is incompatible with the selected scenario", () => {
  assert.throws(
    () =>
      validateClaudeReplayRecordingSelection({
        scenario: "simple",
        configuredQueryMode: "streaming",
        selectedQueryMode: "fork_session_siblings",
        configuredPromptCount: 1,
        selectedPromptCount: 1,
      }),
    "Select a scenario configured for the requested query mode",
  );
});

it("rejects prompt overrides that do not preserve the scenario shape", () => {
  assert.throws(
    () =>
      validateClaudeReplayRecordingSelection({
        scenario: "thread_fork_native_siblings",
        configuredQueryMode: "fork_session_siblings",
        selectedQueryMode: "fork_session_siblings",
        configuredPromptCount: 3,
        selectedPromptCount: 1,
      }),
    "requires exactly 3 prompt(s)",
  );
});

it("accepts the configured scenario mode and prompt shape", () => {
  assert.doesNotThrow(() =>
    validateClaudeReplayRecordingSelection({
      scenario: "thread_fork_native_siblings",
      configuredQueryMode: "fork_session_siblings",
      selectedQueryMode: "fork_session_siblings",
      configuredPromptCount: 3,
      selectedPromptCount: 3,
    }),
  );
});

import { assert, describe, it } from "@effect/vitest";

import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

describe("userFacingDispatchErrorMessage", () => {
  it("returns the deepest actionable domain error instead of generic dispatch wrappers", () => {
    const message = userFacingDispatchErrorMessage({
      message: "Failed to dispatch orchestration command checkpoint.rollback (command-1).",
      cause: {
        message: "Provider adapter failed while dispatching orchestration command command-1.",
        cause: {
          message:
            "claudeAgent cannot satisfy rollback for command command-1: provider conversation rollback is unavailable",
        },
      },
    });

    assert.equal(
      message,
      "claudeAgent cannot satisfy rollback for command command-1: provider conversation rollback is unavailable",
    );
  });

  it("translates policy capability rejections into provider-named prose", () => {
    assert.equal(
      userFacingDispatchErrorMessage({
        message: "Failed to dispatch orchestration command checkpoint.rollback (command-1).",
        cause: {
          _tag: "CommandPolicyCapabilityUnsupportedError",
          commandId: "command-1",
          threadId: "thread-1",
          providerInstanceId: "pi",
          capability: "rollback_snapshot",
          detail: "rollback must return a provider thread snapshot",
          message:
            "pi cannot satisfy rollback_snapshot for command command-1: rollback must return a provider thread snapshot",
        },
      }),
      "Pi did not report its rewound conversation state, so the checkpoint was not restored.",
    );
    assert.equal(
      userFacingDispatchErrorMessage({
        message: "Failed to dispatch orchestration command checkpoint.rollback (command-2).",
        cause: {
          _tag: "CommandPolicyCapabilityUnsupportedError",
          commandId: "command-2",
          threadId: "thread-1",
          providerInstanceId: "grok",
          capability: "rollback",
          detail: "provider conversation rollback is unavailable",
        },
      }),
      "Grok cannot rewind its conversation, so this checkpoint cannot be restored on this thread.",
    );
  });

  it("falls back to the raw message for unknown capability codes", () => {
    assert.equal(
      userFacingDispatchErrorMessage({
        cause: {
          _tag: "CommandPolicyCapabilityUnsupportedError",
          providerInstanceId: "pi",
          capability: "some_future_capability",
          message: "pi cannot satisfy some_future_capability for command command-3: details",
        },
      }),
      "pi cannot satisfy some_future_capability for command command-3: details",
    );
  });

  it("uses explicit detail fields as user-facing messages", () => {
    assert.equal(
      userFacingDispatchErrorMessage({
        message: "Failed to dispatch orchestration command message.dispatch (command-1).",
        cause: {
          detail: "Claude provider thread provider-thread-1 has no live query.",
        },
      }),
      "Claude provider thread provider-thread-1 has no live query.",
    );
  });
});

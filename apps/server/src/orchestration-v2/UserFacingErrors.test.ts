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

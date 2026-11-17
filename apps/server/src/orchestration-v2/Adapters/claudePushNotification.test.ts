import { describe, it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";

import { makeClaudePushNotificationHook } from "./claudePushNotification.ts";

const USER_PRESENT = {
  message: "Not sent — this terminal is active.",
  pushSent: false,
  localSent: false,
  disabledReason: "user_present",
  sentAt: "2026-11-17T12:00:00.000Z",
};

function run(
  hook: ReturnType<typeof makeClaudePushNotificationHook>,
  input: { readonly message?: unknown; readonly response?: unknown; readonly tool?: string },
) {
  return hook(
    {
      hook_event_name: "PostToolUse",
      tool_name: input.tool ?? "PushNotification",
      tool_input: { message: input.message ?? "fleet.lock stuck", status: "proactive" },
      tool_response: input.response ?? USER_PRESENT,
      tool_use_id: "tool-1",
      session_id: "session-1",
      transcript_path: "",
      cwd: "/workspace",
    },
    "tool-1",
    { signal: new AbortController().signal },
  );
}

describe("claudePushNotification", () => {
  it("delivers a push Claude refused as user_present and reports a local send", async () => {
    const delivered: Array<{ readonly id: string; readonly body: string }> = [];
    const hook = makeClaudePushNotificationHook(async (alert) => {
      delivered.push(alert);
      return true;
    });

    NodeAssert.deepEqual(await run(hook, {}), {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: {
          message: "Sent through T3 Code.",
          pushSent: false,
          localSent: true,
          disabledReason: "no_transport",
          sentAt: "2026-11-17T12:00:00.000Z",
        },
        additionalContext:
          "T3 Code passed this notification to a connected T3 Code client with notifications on. That client shows it unless the user already has this thread open.",
      },
    });
    NodeAssert.deepEqual(delivered, [{ id: "tool-1", body: "fleet.lock stuck" }]);
  });

  it("does not tell the model the user is present when no client took the alert", async () => {
    const hook = makeClaudePushNotificationHook(async () => false);

    NodeAssert.deepEqual(await run(hook, {}), {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: {
          message: "Not sent. No T3 Code client with notifications on is connected.",
          pushSent: false,
          localSent: false,
          disabledReason: "no_transport",
          sentAt: "2026-11-17T12:00:00.000Z",
        },
        additionalContext:
          "This notification reached nobody: no T3 Code client with notifications on is connected.",
      },
    });
  });

  it("sends one line of at most 200 characters", async () => {
    const bodies: Array<string> = [];
    const hook = makeClaudePushNotificationHook(async (alert) => {
      bodies.push(alert.body);
      return true;
    });

    await run(hook, { message: "  line\n\nbreak  " });
    await run(hook, { message: "x".repeat(240) });

    NodeAssert.equal(bodies[0], "line break");
    NodeAssert.equal(bodies[1]?.length, 200);
    NodeAssert.equal(bodies[1]?.endsWith("…"), true);
  });

  it("leaves every other result as Claude wrote it", async () => {
    const delivered: Array<string> = [];
    const hook = makeClaudePushNotificationHook(async (alert) => {
      delivered.push(alert.body);
      return true;
    });

    for (const response of [
      { message: "Sent", pushSent: true, localSent: true },
      { message: "Notifications are off.", pushSent: false, disabledReason: "config_off" },
      { message: "No push transport.", pushSent: false, disabledReason: "no_transport" },
    ]) {
      NodeAssert.deepEqual(await run(hook, { response }), {});
    }
    NodeAssert.deepEqual(await run(hook, { tool: "Bash" }), {});
    NodeAssert.deepEqual(await run(hook, { message: "   " }), {});
    NodeAssert.deepEqual(await run(hook, { message: 42 }), {});
    NodeAssert.deepEqual(delivered, []);
  });
});

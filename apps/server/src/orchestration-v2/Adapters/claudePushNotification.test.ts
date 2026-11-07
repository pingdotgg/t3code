import { describe, it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";

import {
  claudePushNotificationHooks,
  claudePushNotificationOutput,
  readClaudePushNotificationMessage,
} from "./claudePushNotification.ts";

describe("claudePushNotification", () => {
  it("keeps a one-line message and caps it at 200 characters", () => {
    NodeAssert.equal(
      readClaudePushNotificationMessage({ message: "  fleet.lock stuck  " }),
      "fleet.lock stuck",
    );
    NodeAssert.equal(readClaudePushNotificationMessage({ message: "line\n\nbreak" }), "line break");
    NodeAssert.equal(readClaudePushNotificationMessage({ message: "   " }), null);
    NodeAssert.equal(readClaudePushNotificationMessage({}), null);
    const long = "x".repeat(240);
    const read = readClaudePushNotificationMessage({ message: long });
    NodeAssert.equal(read?.length, 200);
    NodeAssert.equal(read?.endsWith("…"), true);
  });

  it("does not tell the agent the terminal is active when T3 cannot deliver", () => {
    NodeAssert.deepEqual(
      claudePushNotificationOutput({ channels: { local: false, phone: false } }),
      {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          updatedToolOutput: {
            message: "Not sent. No T3 client or phone accepted the notification.",
            pushSent: false,
            localSent: false,
            disabledReason: "no_transport",
          },
        },
      },
    );
  });

  it("rewrites a user_present result when a T3 channel can deliver", async () => {
    const hooks = claudePushNotificationHooks({
      offer: async () => ({ local: true, phone: false }),
    });
    const hook = hooks.PostToolUse[0]?.hooks[0];
    NodeAssert.ok(hook);
    const result = await hook(
      {
        hook_event_name: "PostToolUse",
        tool_name: "PushNotification",
        tool_input: { message: "fleet.lock stuck", status: "proactive" },
        tool_response: {
          message: "Not sent — this terminal is active.",
          pushSent: false,
          localSent: false,
          disabledReason: "user_present",
        },
        tool_use_id: "tool-1",
        session_id: "session-1",
        transcript_path: "",
        cwd: "/workspace",
      },
      "tool-1",
      { signal: new AbortController().signal },
    );
    NodeAssert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: {
          message: "Sent through T3.",
          pushSent: false,
          localSent: true,
        },
      },
    });
  });

  it("leaves a push Claude already resolved unchanged", async () => {
    const offered: Array<string> = [];
    const hooks = claudePushNotificationHooks({
      offer: async (message) => {
        offered.push(message);
        return { local: true, phone: true };
      },
    });
    const hook = hooks.PostToolUse[0]?.hooks[0];
    NodeAssert.ok(hook);
    const call = (toolResponse: unknown) =>
      hook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "PushNotification",
          tool_input: { message: "fleet.lock stuck", status: "proactive" },
          tool_response: toolResponse,
          tool_use_id: "tool-1",
          session_id: "session-1",
          transcript_path: "",
          cwd: "/workspace",
        },
        "tool-1",
        { signal: new AbortController().signal },
      );
    for (const toolResponse of [
      { message: "Sent", pushSent: true, localSent: true },
      { message: "Notifications are off.", pushSent: false, disabledReason: "config_off" },
      { message: "No push transport.", pushSent: false, disabledReason: "no_transport" },
    ]) {
      NodeAssert.deepEqual(await call(toolResponse), {});
    }
    NodeAssert.deepEqual(offered, []);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { parseChatSyncStatus } from "./chatSync.ts";

describe("parseChatSyncStatus", () => {
  it.each([
    ["never", "", "", { state: "never", message: null, addedChats: null }],
    [
      "running",
      "activating",
      "Starting T3 sync\n12:00:00 Booting the copy with no providers reachable, to stop runs that were in flight...",
      {
        state: "running",
        message:
          "Booting the copy with no providers reachable, to stop runs that were in flight...",
        addedChats: null,
      },
    ],
    [
      "succeeded",
      "inactive",
      "Starting T3 sync\n20:17:46 T3 Learn already has every T3 Code chat; nothing to add.",
      {
        state: "succeeded",
        message: "T3 Learn already has every T3 Code chat; nothing to add.",
        addedChats: 0,
      },
    ],
    [
      "succeeded",
      "inactive",
      "Starting T3 sync\n12:00:00 T3 Learn has every T3 Code chat that is not active or usage-limited; nothing to add.",
      {
        state: "succeeded",
        message:
          "T3 Learn has every T3 Code chat that is not active or usage-limited; nothing to add.",
        addedChats: 0,
      },
    ],
    [
      "succeeded",
      "inactive",
      "Starting T3 sync\n12:00:00 T3 Learn has 2 item(s) running; nothing added. Run again when it is idle.",
      {
        state: "succeeded",
        message: "T3 Learn has 2 item(s) running; nothing added. Run again when it is idle.",
        addedChats: null,
      },
    ],
    [
      "succeeded",
      "inactive",
      "Starting T3 sync\n12:00:00 Done. Added 12 chats, 1 projects. t3learn.service is active.",
      {
        state: "succeeded",
        message: "Done. Added 12 chats, 1 projects. t3learn.service is active.",
        addedChats: 12,
      },
    ],
    [
      "failed",
      "failed",
      "Starting T3 sync\ncopy still has 3 in-flight items; not swapping\nt3-learn-chat-sync.service: Main process exited, code=exited, status=1/FAILURE\nt3-learn-chat-sync.service: Failed with result 'exit-code'.",
      {
        state: "failed",
        message: "copy still has 3 in-flight items; not swapping",
        addedChats: null,
      },
    ],
    [
      "succeeded",
      "inactive",
      "Starting old\n20:00:00 old\nFinished old\nStarting new\n12:00:00 new result",
      { state: "succeeded", message: "new result", addedChats: null },
    ],
  ] as const)("parses %s", (name, activeState, journal, expected) => {
    expect(
      parseChatSyncStatus(
        activeState,
        name === "succeeded" ? "success" : name === "failed" ? "exit-code" : "",
        journal,
      ),
    ).toEqual(expected);
  });
});

import { describe, expect, it } from "vitest";

import { getTerminalBufferReplayKey, getTerminalSurfaceReplayBuffer } from "./terminalBufferReplay";

describe("terminalBufferReplay", () => {
  it("keys replay readiness by terminal identity and font metrics", () => {
    expect(
      getTerminalBufferReplayKey({
        terminalKey: "env-1:thread-1:default",
        fontSize: 10,
      }),
    ).toBe("env-1:thread-1:default:10");
  });

  it("shows terminal history while replay key is unset (initial mount / after key change)", () => {
    const replayKey = getTerminalBufferReplayKey({
      terminalKey: "env-1:thread-1:default",
      fontSize: 10,
    });

    expect(
      getTerminalSurfaceReplayBuffer({
        buffer: "fastfetch output",
        replayKey,
        readyReplayKey: null,
      }),
    ).toBe("fastfetch output");
    expect(
      getTerminalSurfaceReplayBuffer({
        buffer: "fastfetch output",
        replayKey,
        readyReplayKey: "env-1:thread-1:default:11",
      }),
    ).toBe("");
    expect(
      getTerminalSurfaceReplayBuffer({
        buffer: "fastfetch output",
        replayKey,
        readyReplayKey: replayKey,
      }),
    ).toBe("fastfetch output");
  });
});

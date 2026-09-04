import { describe, expect, it } from "vite-plus/test";

import { getTerminalBufferReplayKey, isTerminalBufferReplayPaused } from "./terminalBufferReplay";

describe("terminalBufferReplay", () => {
  it("keys replay readiness by terminal identity and font metrics", () => {
    expect(
      getTerminalBufferReplayKey({
        terminalKey: "env-1:thread-1:default",
        fontSize: 10,
      }),
    ).toBe("env-1:thread-1:default:10");
  });

  it("pauses replay only while an older font layout is still ready", () => {
    const replayKey = getTerminalBufferReplayKey({
      terminalKey: "env-1:thread-1:default",
      fontSize: 10,
    });

    expect(
      isTerminalBufferReplayPaused({
        replayKey,
        readyReplayKey: null,
      }),
    ).toBe(false);
    expect(
      isTerminalBufferReplayPaused({
        replayKey,
        readyReplayKey: "env-1:thread-1:default:11",
      }),
    ).toBe(true);
    expect(
      isTerminalBufferReplayPaused({
        replayKey,
        readyReplayKey: replayKey,
      }),
    ).toBe(false);
  });
});

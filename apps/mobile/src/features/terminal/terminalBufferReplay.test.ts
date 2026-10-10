import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";
const history: TerminalOutputState = {
  ...EMPTY_TERMINAL_BUFFER_STATE.output,
  chunks: [{ startOffset: 0, data: "fastfetch output", byteLength: 15 }],
  nextOffset: 15,
  retainedBytes: 15,
};
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
        buffer: history,
        replayKey,
        readyReplayKey: null,
      }),
    ).toBe(history);
    expect(
      getTerminalSurfaceReplayBuffer({
        buffer: history,
        replayKey,
        readyReplayKey: "env-1:thread-1:default:11",
      }),
    ).toBe(EMPTY_TERMINAL_BUFFER_STATE.output);
    expect(
      getTerminalSurfaceReplayBuffer({
        buffer: history,
        replayKey,
        readyReplayKey: replayKey,
      }),
    ).toBe(history);
  });
});

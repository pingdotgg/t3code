import { describe, expect, it } from "vite-plus/test";

import {
  getTerminalBufferReplayKey,
  isTerminalBufferReplayPaused,
  nativeTerminalOutputCommands,
} from "./terminalBufferReplay";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
} from "@t3tools/client-runtime/state/terminal";

describe("terminalBufferReplay", () => {
  it("keeps unread live queries out of the native reset command", () => {
    const output = {
      generation: 1,
      resetVersion: 1,
      nextOffset: 13,
      retainedBytes: 13,
      chunks: [
        { startOffset: 0, data: "old\x1b[6n", delivery: "replay" as const, byteLength: 7 },
        { startOffset: 7, data: "hi\x1b[6n", delivery: "live" as const, byteLength: 6 },
      ],
    };
    const update = readTerminalOutputUpdate(output, INITIAL_TERMINAL_OUTPUT_CURSOR);
    expect(nativeTerminalOutputCommands(update)).toEqual([
      { type: "reset", data: "old\x1b[6n" },
      { type: "write", data: "hi\x1b[6n" },
    ]);
    expect(
      nativeTerminalOutputCommands(readTerminalOutputUpdate(output, update.cursor, true)),
    ).toEqual([{ type: "reset", data: "old\x1b[6nhi\x1b[6n" }]);
  });
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

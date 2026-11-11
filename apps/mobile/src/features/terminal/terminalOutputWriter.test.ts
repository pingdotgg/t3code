import {
  applyTerminalAttachStreamEvent,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  EMPTY_TERMINAL_BUFFER_STATE,
  terminalOutputText,
} from "@t3tools/client-runtime/state/terminal";
import { expect, it, vi } from "vite-plus/test";

import { createTerminalOutputWriter } from "./terminalOutputWriter";

function append(
  state: typeof EMPTY_TERMINAL_BUFFER_STATE,
  data: string,
  limit = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
) {
  return applyTerminalAttachStreamEvent(
    state,
    { type: "output", data, threadId: "thread", terminalId: "term-1" },
    limit,
  );
}

it("appends across rollover without replay and seeds fresh writers with only bounded history", async () => {
  const write = vi.fn(async (_data: string, _reset: boolean) => {});
  const writer = createTerminalOutputWriter(write);
  let state = EMPTY_TERMINAL_BUFFER_STATE;
  const chunks: string[] = [];
  await writer.write(state.output);
  for (let index = 0; index < 128; index += 1) {
    const chunk = `${index}\r\n`.padEnd(16 * 1024, "x");
    chunks.push(chunk);
    state = append(state, chunk);
    await writer.write(state.output);
    expect(write).toHaveBeenLastCalledWith(chunk, false);
  }
  expect(state.output.retainedBytes).toBe(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
  const retained = chunks.slice(-32).join("");
  expect(terminalOutputText(state.output)).toBe(retained);
  expect(write.mock.calls.filter(([, reset]) => reset)).toEqual([["", true]]);
  expect(write.mock.calls.reduce((total, [data]) => total + data.length, 0)).toBe(2 * 1024 * 1024);

  const remountedWrite = vi.fn(async () => {});
  await createTerminalOutputWriter(remountedWrite).write(state.output);
  expect(remountedWrite.mock.calls).toEqual([[retained, true]]);
});

it("recovers the newer snapshot queued during a rejected append without a third write", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = vi.fn(async () => {});
  const writer = createTerminalOutputWriter(write);
  const initial = append(EMPTY_TERMINAL_BUFFER_STATE, "initial");
  await writer.write(initial.output);
  write.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    throw new Error("partially applied append");
  });
  const first = append(initial, "-first");
  const draining = writer.write(first.output);
  await started.promise;
  const latest = append(first, "-latest");
  void writer.write(latest.output);
  release.resolve();
  await draining;
  expect(write.mock.calls).toEqual([
    ["initial", true],
    ["-first", false],
    ["initial-first-latest", true],
  ]);
  await writer.write(append(latest, "-next").output);
  expect(write).toHaveBeenLastCalledWith("-next", false);
});

import * as NodeModule from "node:module";
import { act, createElement, useLayoutEffect, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  applyTerminalAttachStreamEvent,
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";
import { ThreadId } from "@t3tools/contracts";
import { useNativeTerminalBuffer } from "./useNativeTerminalBuffer";

const { createRoot } = NodeModule.createRequire(import.meta.url)("react-dom/client") as {
  createRoot(container: Element): { render(children: ReactNode): void; unmount(): void };
};
let root: ReturnType<typeof createRoot>;
let current: ReturnType<typeof useNativeTerminalBuffer>;
const writes = vi.fn<(value: ReturnType<typeof useNativeTerminalBuffer>["bufferWrite"]) => void>();
function Probe({ terminalKey, buffer }: { terminalKey: string; buffer: TerminalOutputState }) {
  const result = useNativeTerminalBuffer(terminalKey, buffer);
  useLayoutEffect(() => {
    current = result;
    writes(result.bufferWrite);
  }, [result]);
  return null;
}
function render(buffer: TerminalOutputState, terminalKey = "environment:thread:terminal") {
  return act(() => root.render(createElement(Probe, { terminalKey, buffer })));
}
let session = EMPTY_TERMINAL_BUFFER_STATE;
function replace(history: string) {
  session = applyTerminalAttachStreamEvent(session, {
    type: "snapshot",
    snapshot: {
      threadId: ThreadId.make("fixture-thread"),
      terminalId: "fixture-terminal",
      cwd: "/tmp",
      worktreePath: null,
      status: "running",
      pid: 1,
      history,
      exitCode: null,
      exitSignal: null,
      label: "Terminal",
      updatedAt: "2026-10-08T00:00:00Z",
    },
  });
  return session.output;
}
function append(data: string) {
  session = applyTerminalAttachStreamEvent(session, {
    type: "output",
    threadId: ThreadId.make("fixture-thread"),
    terminalId: "fixture-terminal",
    data,
  });
  return session.output;
}
beforeEach(() => {
  session = EMPTY_TERMINAL_BUFFER_STATE;
  writes.mockClear();
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("transfers only acknowledged suffixes, with UTF-16 offsets", async () => {
  await render(replace("hello 🌍"));
  expect(current.bufferWrite).toEqual({ generation: 1, offset: 0, data: "hello 🌍" });
  await act(() => current.acknowledge({ generation: 1, offset: 8 }));
  await render(append("\r\nnext"));
  expect(current.bufferWrite).toEqual({ generation: 1, offset: 8, data: "\r\nnext" });
});

it("retains unacknowledged output when React batches multiple updates", async () => {
  await render(replace("a"));
  await act(() => {
    root.render(
      createElement(Probe, { terminalKey: "environment:thread:terminal", buffer: append("b") }),
    );
    root.render(
      createElement(Probe, { terminalKey: "environment:thread:terminal", buffer: append("c") }),
    );
  });
  expect(current.bufferWrite).toEqual({ generation: 1, offset: 0, data: "abc" });
  await act(() => current.acknowledge({ generation: 1, offset: 1 }));
  expect(current.bufferWrite).toEqual({ generation: 1, offset: 1, data: "bc" });
});

it.each(["", "replacement", "retained suffix"])(
  "restarts on replacement history %j and ignores stale acknowledgements",
  async (buffer) => {
    await render(replace("previous output"));
    await render(replace(buffer));
    expect(current.bufferWrite).toEqual({ generation: 2, offset: 0, data: buffer });
    await act(() => current.acknowledge({ generation: 1, offset: 10 }));
    expect(current.bufferWrite).toEqual({ generation: 2, offset: 0, data: buffer });
  },
);

it("does not carry acknowledgements across terminal identity", async () => {
  await render(replace("old output"));
  const oldAcknowledge = current.acknowledge;
  await render(replace("new output"), "other:thread:terminal");
  await act(() => oldAcknowledge({ generation: 2, offset: 10 }));
  expect(current.bufferWrite).toEqual({ generation: 2, offset: 0, data: "new output" });
});

it("ignores duplicate, impossible and malformed acknowledgements", async () => {
  await render(replace("abc"));
  await act(() => current.acknowledge({ generation: 1, offset: 2 }));
  await act(() => {
    for (const offset of [1, 2, 4, -1, 1.5, NaN]) current.acknowledge({ generation: 1, offset });
  });
  expect(current.bufferWrite).toEqual({ generation: 1, offset: 2, data: "c" });
});

it("keeps rollover incremental after a full512KiB prefill", async () => {
  await render(replace("x".repeat(512 * 1024)));
  let bytes = 0;
  let offset = 512 * 1024;
  await act(() => current.acknowledge({ generation: 1, offset }));
  for (let index = 0; index < 1000; index++) {
    await render(append("y".repeat(1024)));
    expect(current.bufferWrite.generation).toBe(1);
    expect(current.bufferWrite.offset).toBe(offset);
    bytes += current.bufferWrite.data.length;
    offset += 1024;
    await act(() => current.acknowledge({ generation: 1, offset }));
  }
  expect(bytes).toBe(1000 * 1024);
});

it("catches up after skipped acknowledgements, then resets when required history is gone", async () => {
  await render(replace("x".repeat(512 * 1024)));
  await act(() => current.acknowledge({ generation: 1, offset: 512 * 1024 }));
  await render(append("a".repeat(1024)));
  await render(append("b".repeat(1024)));
  expect(current.bufferWrite).toEqual({
    generation: 1,
    offset: 512 * 1024,
    data: "a".repeat(1024) + "b".repeat(1024),
  });
  await render(append("c".repeat(512 * 1024)));
  expect(current.bufferWrite.generation).toBe(2);
  expect(current.bufferWrite.offset).toBe(0);
  expect(current.bufferWrite.data).toBe("c".repeat(512 * 1024));
});

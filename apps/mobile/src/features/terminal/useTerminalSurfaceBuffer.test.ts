import * as NodeModule from "node:module";
import { act, createElement, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useTerminalSurfaceBuffer } from "./useTerminalSurfaceBuffer";

const { createRoot } = NodeModule.createRequire(import.meta.url)("react-dom/client") as {
  createRoot(container: Element): {
    render(children: ReactNode): void;
    unmount(): void;
  };
};

type Input = Parameters<typeof useTerminalSurfaceBuffer>[0] & { readonly readOnly: boolean };
let root: ReturnType<typeof createRoot>;
const displayed = vi.fn<(value: { buffer: string; readOnly: boolean }) => void>();

function BufferProbe(input: Input) {
  const buffer = useTerminalSurfaceBuffer(input);
  useEffect(() => {
    displayed({ buffer, readOnly: input.readOnly });
  }, [buffer, input.readOnly]);
  return null;
}

function render(changes: Partial<Input> = {}) {
  return act(() =>
    root.render(
      createElement(BufferProbe, {
        terminalKey: "environment:thread:term-1",
        buffer: "host output",
        readOnly: false,
        ...changes,
      }),
    ),
  );
}

beforeEach(() => {
  displayed.mockClear();
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

it("preserves displayed history while permissions change before the next snapshot", async () => {
  await render();
  await render({ buffer: null, readOnly: true });
  expect(displayed).toHaveBeenLastCalledWith({ buffer: "host output", readOnly: true });

  await render({ buffer: "host output\nobserved output", readOnly: true });
  await render({ buffer: null });
  expect(displayed).toHaveBeenLastCalledWith({
    buffer: "host output\nobserved output",
    readOnly: false,
  });
  expect(displayed.mock.calls.every(([value]) => value.buffer.length > 0)).toBe(true);
});

it("still applies an intentional empty buffer", async () => {
  await render();
  await render({ buffer: null });
  expect(displayed).toHaveBeenCalledTimes(1);
  await render({ buffer: "" });
  expect(displayed).toHaveBeenLastCalledWith({ buffer: "", readOnly: false });
});

it.each([
  "secondary:thread:term-1",
  "environment:another-thread:term-1",
  "environment:thread:term-2",
])("does not carry history into another terminal target (%s)", async (terminalKey) => {
  await render();
  await render({ terminalKey, buffer: null });
  expect(displayed).toHaveBeenLastCalledWith({ buffer: "", readOnly: false });
  await render({ terminalKey, buffer: "new target" });
  expect(displayed).toHaveBeenLastCalledWith({ buffer: "new target", readOnly: false });
});

it("starts empty until its first snapshot arrives", async () => {
  await render({ buffer: null });
  expect(displayed).toHaveBeenLastCalledWith({ buffer: "", readOnly: false });
  await render();
  expect(displayed).toHaveBeenLastCalledWith({ buffer: "host output", readOnly: false });
});

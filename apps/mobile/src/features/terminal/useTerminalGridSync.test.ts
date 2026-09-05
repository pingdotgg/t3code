import * as NodeModule from "node:module";
import { EMPTY_TERMINAL_BUFFER_STATE } from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useTerminalGridSync } from "./useTerminalGridSync";

// Mobile already depends on ReactDOM but does not install its browser type declarations.
const { createRoot } = NodeModule.createRequire(import.meta.url)("react-dom/client") as {
  createRoot(container: Element): {
    render(children: ReactNode): void;
    unmount(): void;
  };
};

type Input = Parameters<typeof useTerminalGridSync>[0];
let root: ReturnType<typeof createRoot>;
const resize = vi.fn<Input["resize"]>();

function GridProbe(input: Input) {
  useTerminalGridSync(input);
  return null;
}

function session({
  generation = 1,
  version = 1,
  status = "running",
}: {
  readonly generation?: number;
  readonly version?: number;
  readonly status?: Input["terminal"]["status"];
} = {}): Input["terminal"] {
  return { output: { ...EMPTY_TERMINAL_BUFFER_STATE.output, generation }, version, status };
}

function input(): Input {
  return {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    terminalId: "term-1",
    canOperate: true,
    terminal: session(),
    size: { cols: 80, rows: 24 },
    resize,
  };
}

function render(value: Input) {
  return act(() => root.render(createElement(GridProbe, value)));
}

beforeEach(() => {
  resize.mockClear();
  // The probe renders no DOM, but ReactDOM needs an event target to run real effects.
  const document = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
  };
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

it("replays an observer's measured grid once its writable attachment snapshot arrives", async () => {
  let current = { ...input(), canOperate: false };
  await render(current);
  current = { ...current, size: { cols: 120, rows: 40 } };
  await render(current);
  expect(resize).not.toHaveBeenCalled();

  current = {
    ...current,
    canOperate: true,
    terminal: session({ generation: 2, version: 0 }),
  };
  await render(current);
  expect(resize).not.toHaveBeenCalled();

  current = { ...current, terminal: session({ generation: 2 }) };
  await render(current);
  expect(resize).toHaveBeenCalledExactlyOnceWith({
    environmentId: "environment",
    input: { threadId: "thread", terminalId: "term-1", cols: 120, rows: 40 },
  });

  await render({ ...current, terminal: session({ generation: 2, version: 3 }) });
  await render({ ...current, size: { ...current.size } });
  expect(resize).toHaveBeenCalledOnce();

  await render({ ...current, size: { cols: 120, rows: 41 } });
  expect(resize).toHaveBeenCalledTimes(2);
  expect(resize).toHaveBeenLastCalledWith({
    environmentId: "environment",
    input: { threadId: "thread", terminalId: "term-1", cols: 120, rows: 41 },
  });
});

it("replays an unchanged grid after reconnecting with a new attachment generation", async () => {
  const current = { ...input(), size: { cols: 120, rows: 40 } };
  await render(current);
  expect(resize).toHaveBeenCalledOnce();

  await render({ ...current, terminal: session({ generation: 2, version: 0 }) });
  expect(resize).toHaveBeenCalledOnce();

  await render({ ...current, terminal: session({ generation: 2 }) });
  expect(resize).toHaveBeenCalledTimes(2);
  expect(resize).toHaveBeenLastCalledWith({
    environmentId: "environment",
    input: { threadId: "thread", terminalId: "term-1", cols: 120, rows: 40 },
  });

  // React may observe the next snapshot without rendering the empty seed first.
  await render({ ...current, terminal: session({ generation: 3 }) });
  expect(resize).toHaveBeenCalledTimes(3);
});

it.each([
  { name: "permission is revoked", change: { canOperate: false } },
  { name: "the attachment is pending", change: { terminal: session({ version: 0 }) } },
  { name: "the process has exited", change: { terminal: session({ status: "exited" }) } },
])("retains measurements without resizing while $name", async ({ change }) => {
  const current = input();
  await render(current);
  expect(resize).toHaveBeenCalledOnce();

  await render({ ...current, ...change, size: { cols: 120, rows: 40 } });
  await render({ ...current, ...change, size: { cols: 120, rows: 41 } });
  expect(resize).toHaveBeenCalledOnce();

  await render({ ...current, size: { cols: 120, rows: 41 } });
  expect(resize).toHaveBeenCalledTimes(2);
  expect(resize).toHaveBeenLastCalledWith({
    environmentId: "environment",
    input: { threadId: "thread", terminalId: "term-1", cols: 120, rows: 41 },
  });
});

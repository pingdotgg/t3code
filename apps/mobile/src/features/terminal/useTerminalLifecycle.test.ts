import * as NodeModule from "node:module";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useTerminalLifecycle } from "./useTerminalLifecycle";

const { createRoot } = NodeModule.createRequire(import.meta.url)("react-dom/client") as {
  createRoot(container: Element): {
    render(children: ReactNode): void;
    unmount(): void;
  };
};

type Input = Parameters<typeof useTerminalLifecycle>[0];
let root: ReturnType<typeof createRoot>;
const reopen = vi.fn<Input["reopen"]>();
const onRunning = vi.fn<Input["onRunning"]>();
const onExit = vi.fn<Input["onExit"]>();

function LifecycleProbe(input: Input) {
  useTerminalLifecycle(input);
  return null;
}

function input(changes: Partial<Input> = {}): Input {
  return {
    terminalKey: "environment:thread:term-1",
    canOperate: true,
    attached: true,
    terminal: { status: "running", version: 1 },
    reopen,
    onRunning,
    onExit,
    ...changes,
  };
}

function render(value: Input) {
  return act(() => root.render(createElement(LifecycleProbe, value)));
}

beforeEach(() => {
  reopen.mockReset().mockResolvedValue(true);
  onRunning.mockClear();
  onExit.mockClear();
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

it.each(["running", "closed", "exited"] as const)(
  "waits for the replacement attachment snapshot before handling %s",
  async (status) => {
    await render(input());
    await render(input({ terminal: { status: "closed", version: 0 } }));
    expect(onExit).not.toHaveBeenCalled();
    expect(reopen).not.toHaveBeenCalled();

    await render(input({ terminal: { status, version: 1 } }));
    expect(onExit).toHaveBeenCalledTimes(status === "running" ? 0 : 1);
    expect(reopen).not.toHaveBeenCalled();
  },
);

it("retains an exited observer's history after gaining operate", async () => {
  await render(input({ canOperate: false, terminal: { status: "exited", version: 1 } }));
  await render(input({ terminal: { status: "closed", version: 0 } }));
  await render(input({ terminal: { status: "exited", version: 1 } }));
  expect(reopen).not.toHaveBeenCalled();
  expect(onExit).not.toHaveBeenCalled();
});

it("does not respawn a terminal that exited after operate was revoked", async () => {
  await render(input());
  await render(input({ canOperate: false }));
  await render(input({ canOperate: false, terminal: { status: "exited", version: 2 } }));
  await render(input({ terminal: { status: "exited", version: 1 } }));
  expect(reopen).not.toHaveBeenCalled();
  expect(onExit).not.toHaveBeenCalled();
});

it("remembers revocation before the observer has received a snapshot", async () => {
  await render(input());
  await render(input({ canOperate: false, terminal: { status: "closed", version: 0 } }));
  await render(input({ terminal: { status: "exited", version: 1 } }));
  expect(reopen).not.toHaveBeenCalled();
  expect(onExit).not.toHaveBeenCalled();
});

it("cleans up an actual exit after an observed running terminal becomes writable", async () => {
  await render(input({ canOperate: false }));
  await render(input());
  await render(input({ terminal: { status: "exited", version: 2 } }));
  await render(input({ terminal: { status: "closed", version: 3 } }));
  expect(onExit).toHaveBeenCalledOnce();
  expect(reopen).not.toHaveBeenCalled();
});

it("reopens an ended terminal on an explicit new route visit", async () => {
  await render(input({ canOperate: false, terminal: { status: "exited", version: 1 } }));
  await render(input({ terminalKey: "environment:thread:term-2" }));
  await render(input({ terminal: { status: "exited", version: 1 } }));
  expect(reopen).toHaveBeenCalledOnce();

  await render(input({ terminal: { status: "exited", version: 2 } }));
  expect(reopen).toHaveBeenCalledOnce();
  await render(input({ terminal: { status: "running", version: 3 } }));
  await render(input({ terminal: { status: "exited", version: 4 } }));
  expect(onExit).toHaveBeenCalledOnce();
});

it("keeps a detached terminal from being mistaken for a live exit", async () => {
  await render(input());
  await render(input({ attached: false, terminal: { status: "closed", version: 0 } }));
  await render(input({ terminal: { status: "exited", version: 1 } }));
  expect(onExit).not.toHaveBeenCalled();
  expect(reopen).toHaveBeenCalledOnce();
});

it("allows a later snapshot to retry an unsuccessful explicit reopen", async () => {
  reopen.mockResolvedValueOnce(false);
  await render(input({ terminal: { status: "exited", version: 1 } }));
  await render(input({ terminal: { status: "exited", version: 2 } }));
  expect(reopen).toHaveBeenCalledTimes(2);
});

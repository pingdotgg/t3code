import { EnvironmentId, ThreadId, type TerminalSummary } from "@t3tools/contracts";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useKnownTerminalSessions } from "./terminalSessions";

const state = vi.hoisted(() => ({
  canRead: true,
  data: null as ReadonlyArray<TerminalSummary> | null,
  error: null as string | null,
}));

vi.mock("./session", () => ({ useEnvironmentScope: () => state.canRead }));
vi.mock("./terminal", () => ({ terminalEnvironment: { metadata: () => ({}) } }));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === null ? { data: null, error: null } : { data: state.data, error: state.error },
}));

let root: Root;
let current: ReturnType<typeof useKnownTerminalSessions>;
const target = {
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
};
const terminal: TerminalSummary = {
  threadId: "thread",
  terminalId: "term-1",
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 123,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: true,
  label: "Busy process",
  updatedAt: "2026-09-05T00:00:00.000Z",
};

function Probe() {
  const sessions = useKnownTerminalSessions(target);
  useEffect(() => {
    current = sessions;
  }, [sessions]);
  return null;
}

function render() {
  return act(() => root.render(createElement(Probe)));
}

beforeEach(() => {
  state.canRead = true;
  state.data = null;
  state.error = null;
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

it("distinguishes missing metadata from an authoritative empty list across scope changes", async () => {
  await render();
  expect(current).toBeNull();

  state.data = [terminal];
  await render();
  expect(current?.[0]).toMatchObject({
    target: { environmentId: "secondary", terminalId: "term-1" },
    state: { hasRunningSubprocess: true },
  });

  state.canRead = false;
  await render();
  expect(current).toBeNull();

  state.canRead = true;
  state.data = [];
  await render();
  expect(current).toEqual([]);
});

it("does not reuse cached terminal metadata after a subscription failure", async () => {
  state.data = [terminal];
  await render();
  state.error = "Access denied";
  await render();
  expect(current).toBeNull();
});

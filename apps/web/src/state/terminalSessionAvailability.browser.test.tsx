import { EnvironmentId, ThreadId, type TerminalSummary } from "@t3tools/contracts";
import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useKnownTerminalSessions } from "./terminalSessions";

const state = vi.hoisted(() => ({
  canRead: true,
  data: null as ReadonlyArray<TerminalSummary> | null,
  error: null as string | null,
}));

vi.mock(import("./session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.canRead,
}));
vi.mock(import("./query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) =>
    atom === null
      ? { data: null, error: null }
      : { data: state.data, error: state.error }) as never,
}));

type KnownSessions = ReturnType<typeof useKnownTerminalSessions>;
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

function Probe({ onSessions }: { onSessions: (sessions: KnownSessions) => void }) {
  const sessions = useKnownTerminalSessions(target);
  useEffect(() => {
    onSessions(sessions);
  }, [onSessions, sessions]);
  return null;
}

function setup() {
  Object.assign(state, { canRead: true, data: null, error: null });
  let current: KnownSessions | undefined;
  const onSessions = (sessions: KnownSessions) => {
    current = sessions;
  };
  return {
    get current() {
      return current;
    },
    element: () => <Probe onSessions={onSessions} />,
  };
}

it("distinguishes missing metadata from an authoritative empty list across scope changes", async () => {
  const probe = setup();
  await using screen = await render(probe.element());
  expect(probe.current).toBeNull();

  state.data = [terminal];
  await screen.rerender(probe.element());
  expect(probe.current?.[0]).toMatchObject({
    target: { environmentId: "secondary", terminalId: "term-1" },
    state: { hasRunningSubprocess: true },
  });

  state.canRead = false;
  await screen.rerender(probe.element());
  expect(probe.current).toBeNull();

  state.canRead = true;
  state.data = [];
  await screen.rerender(probe.element());
  expect(probe.current).toEqual([]);
});

it("does not reuse cached terminal metadata after a subscription failure", async () => {
  const probe = setup();
  state.data = [terminal];
  await using screen = await render(probe.element());
  state.error = "Access denied";
  await screen.rerender(probe.element());
  expect(probe.current).toBeNull();
});

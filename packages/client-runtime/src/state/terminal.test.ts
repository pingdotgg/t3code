import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createTerminalSession,
  INITIAL_TERMINAL_LIFECYCLE,
  transitionTerminalLifecycle,
  type TerminalLifecycleEvent,
  type TerminalSessionMode,
} from "./terminal.ts";
import { EMPTY_TERMINAL_BUFFER_STATE, type TerminalBufferState } from "./terminalSession.ts";

function run(events: ReadonlyArray<TerminalLifecycleEvent>) {
  let state = INITIAL_TERMINAL_LIFECYCLE;
  const commands: Array<string> = [];
  for (const event of events) {
    const step = transitionTerminalLifecycle(state, event);
    state = step.state;
    if (step.command !== null) commands.push(step.command);
  }
  return commands;
}

const status = (value: TerminalBufferState["status"], version = 1): TerminalLifecycleEvent => ({
  type: "status",
  status: value,
  version,
});

it("does not respawn a terminal that exited after operate was revoked", () => {
  expect(
    run([status("running"), { type: "detached", canOperate: false }, status("exited")]),
  ).toEqual([]);
});

it("reopens an ended terminal on an explicit visit, once until it runs again", () => {
  expect(run([status("exited"), status("exited", 2)])).toEqual(["reopen"]);
  expect(run([status("exited"), status("running", 3), status("exited", 4)])).toEqual([
    "reopen",
    "exit",
  ]);
  expect(run([status("exited"), { type: "reopen-failed" }, status("exited", 2)])).toEqual([
    "reopen",
    "reopen",
  ]);
});

it("keeps a detached terminal from being mistaken for a live exit", () => {
  expect(
    run([status("running"), { type: "detached", canOperate: true }, status("exited")]),
  ).toEqual(["reopen"]);
});

it("leaves the history a viewer was reading when operate is granted", () => {
  expect(run([{ type: "observed" }, status("exited")])).toEqual([]);
});

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");

function setup(options: { readonly initialInput?: string } = {}) {
  // Tests flush the registry's scheduled work to control when driver finalizers run.
  const scheduled: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.push(task);
      return () => {};
    },
  });
  const flush = () => {
    for (const task of scheduled.splice(0)) task();
  };
  const attachment = Atom.make<AsyncResult.AsyncResult<TerminalBufferState, unknown>>(
    AsyncResult.initial(true),
  );
  const observation = Atom.make<AsyncResult.AsyncResult<TerminalBufferState, unknown>>(
    AsyncResult.initial(true),
  );
  const access = { canOperate: true };
  const calls: Array<{ readonly command: string; readonly input: unknown }> = [];
  const command = (name: string) => ({
    label: name,
    run: async (_registry: AtomRegistry.AtomRegistry, value: { readonly input: unknown }) => {
      calls.push({ command: name, input: value.input });
      return AsyncResult.success(undefined);
    },
  });
  const exits: Array<true> = [];
  const live: Array<boolean> = [];
  const session = createTerminalSession(
    {
      attach: () => attachment,
      observe: () => observation,
      open: command("open"),
      resize: command("resize"),
      write: command("write"),
      close: command("close"),
    },
    {
      target: { environmentId, threadId, terminalId: "term-1" },
      gridSize: { cols: 120, rows: 40 },
      initialInput: options.initialInput,
      canOperate: () => access.canOperate,
      onExit: () => exits.push(true),
      onLiveChange: (value) => live.push(value),
    },
  );
  const attached: TerminalSessionMode = {
    kind: "attached",
    input: { threadId, terminalId: "term-1", cwd: "/repo", cols: 80, rows: 24 },
  };
  const snapshot = (state: Partial<TerminalBufferState> & { readonly generation?: number }) => {
    const { generation = 1, ...rest } = state;
    return AsyncResult.success({
      ...EMPTY_TERMINAL_BUFFER_STATE,
      output: { ...EMPTY_TERMINAL_BUFFER_STATE.output, generation },
      ...rest,
    });
  };
  const emit = (state: Partial<TerminalBufferState> & { readonly generation?: number }) =>
    registry.set(attachment, snapshot(state));
  // A new attach subscription starts from an empty seed.
  const detach = () => registry.set(attachment, AsyncResult.initial(true));
  const observe = (state: Partial<TerminalBufferState>) =>
    registry.set(observation, snapshot(state));
  const mount = (mode: TerminalSessionMode) => registry.mount(session.driver(mode));
  const of = (name: string) => calls.filter((call) => call.command === name).map((c) => c.input);
  return { session, attached, access, flush, detach, emit, observe, mount, calls, of, exits, live };
}

it("replays the measured grid on every new attachment generation", () => {
  const { session, attached, emit, mount, of } = setup();
  mount(attached);
  emit({ status: "running", version: 1 });
  expect(of("resize")).toEqual([{ threadId, terminalId: "term-1", cols: 120, rows: 40 }]);

  session.reportGridSize({ cols: 100, rows: 30 });
  expect(of("resize")).toHaveLength(2);
  session.reportGridSize({ cols: 100, rows: 30 });
  expect(of("resize")).toHaveLength(2);

  // A reconnect seeds an empty state first, then the new generation's snapshot.
  emit({ status: "running", version: 0, generation: 2 });
  expect(of("resize")).toHaveLength(2);
  emit({ status: "running", version: 1, generation: 2 });
  expect(of("resize")).toHaveLength(3);
  emit({ status: "running", version: 2, generation: 3 });
  expect(of("resize")).toEqual([
    { threadId, terminalId: "term-1", cols: 120, rows: 40 },
    { threadId, terminalId: "term-1", cols: 100, rows: 30 },
    { threadId, terminalId: "term-1", cols: 100, rows: 30 },
    { threadId, terminalId: "term-1", cols: 100, rows: 30 },
  ]);
});

it("writes the launch's initial input once the first snapshot lands", () => {
  const { attached, emit, mount, calls, of } = setup({ initialInput: "pnpm dev\r" });
  mount(attached);
  expect(of("write")).toEqual([]);
  emit({ status: "running", version: 1 });
  emit({ status: "running", version: 2 });
  expect(of("write")).toEqual([{ threadId, terminalId: "term-1", data: "pnpm dev\r" }]);
  // The shell gets the measured grid before the launched command runs.
  expect(calls.map((call) => call.command)).toEqual(["resize", "write"]);
});

it("closes and reports a shell that exits while attached", () => {
  const { attached, emit, mount, of, exits, live } = setup();
  mount(attached);
  emit({ status: "running", version: 1, lifecycleVersion: 0 });
  emit({ status: "exited", version: 2 });
  expect(of("close")).toEqual([{ threadId, terminalId: "term-1" }]);
  expect(of("open")).toEqual([]);
  expect(exits).toHaveLength(1);
  expect(live).toEqual([true, false]);
});

it("does not reopen an ended shell after a viewer is granted operate", () => {
  const { attached, flush, access, emit, observe, mount, of } = setup();
  access.canOperate = false;
  const unmountViewer = mount({ kind: "observing" });
  observe({ status: "exited", version: 1 });
  access.canOperate = true;
  unmountViewer();
  flush();
  mount(attached);
  emit({ status: "exited", version: 1 });
  expect(of("open")).toEqual([]);
});

it("does not reopen on grant when the viewer had no snapshot yet", () => {
  const { attached, flush, access, emit, mount, of } = setup();
  access.canOperate = false;
  const unmountViewer = mount({ kind: "observing" });
  access.canOperate = true;
  unmountViewer();
  flush();
  mount(attached);
  emit({ status: "exited", version: 1 });
  expect(of("open")).toEqual([]);
});

it("leaves a shell that exited after operate was revoked mid-run", () => {
  const { attached, flush, access, detach, emit, mount, of, exits } = setup();
  const unmountAttached = mount(attached);
  emit({ status: "running", version: 1 });
  access.canOperate = false;
  unmountAttached();
  flush();
  detach();
  access.canOperate = true;
  mount(attached);
  emit({ status: "exited", version: 2 });
  expect(of("open")).toEqual([]);
  expect(of("close")).toEqual([]);
  expect(exits).toEqual([]);
});

it("reopens instead of closing a shell that ended while detached", () => {
  const { attached, flush, detach, emit, mount, of, exits } = setup();
  const unmountAttached = mount(attached);
  emit({ status: "running", version: 1 });
  unmountAttached();
  flush();
  detach();
  mount(attached);
  emit({ status: "exited", version: 2 });
  expect(of("close")).toEqual([]);
  expect(exits).toEqual([]);
  expect(of("open")).toHaveLength(1);
});

it("keeps a replaced attachment's late release from resetting the new one", () => {
  const { attached, flush, emit, mount, of, exits } = setup();
  const unmountFirst = mount(attached);
  emit({ status: "running", version: 1 });
  mount({
    kind: "attached",
    input: { threadId, terminalId: "term-1", cwd: "/repo/worktree", cols: 80, rows: 24 },
  });
  unmountFirst();
  flush();
  emit({ status: "exited", version: 2 });
  expect(of("close")).toHaveLength(1);
  expect(exits).toHaveLength(1);
});

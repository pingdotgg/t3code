import {
  EnvironmentId,
  ThreadId,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalWriteInput,
  type TerminalCloseInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createTerminalSession,
  INITIAL_TERMINAL_LIFECYCLE,
  transitionTerminalLifecycle,
  type TerminalLifecycleEvent,
  type TerminalSessionMode,
} from "./terminal.ts";
import { runAtomCommand } from "./runtime.ts";
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

type CommandInput =
  | TerminalOpenInput
  | TerminalResizeInput
  | TerminalWriteInput
  | TerminalCloseInput;

function setup(
  options: {
    readonly initialInput?: string;
    readonly beforeCommand?: (name: string, input: CommandInput) => Promise<void>;
    readonly resizeFailure?: () => boolean;
  } = {},
) {
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
  const calls: Array<{ readonly command: string; readonly input: CommandInput }> = [];
  const pending: Promise<unknown>[] = [];
  const command = (name: string) => ({
    label: name,
    run: (_registry: AtomRegistry.AtomRegistry, value: { readonly input: CommandInput }) => {
      const result = (async () => {
        calls.push({ command: name, input: value.input });
        if (options.beforeCommand) await options.beforeCommand(name, value.input);
        return name === "resize" && options.resizeFailure?.()
          ? AsyncResult.failure(Cause.fail("resize rejected"))
          : AsyncResult.success(undefined);
      })();
      pending.push(result);
      return result;
    },
  });
  const write = command("write");
  // Await command completion, then a normal input receipt through the same command runner.
  const completeCommands = async (count = pending.length) => {
    await Promise.all(pending.slice(0, count));
    await runAtomCommand(registry, write, {
      input: { threadId, terminalId: "term-1", data: "typed" },
    });
  };
  const exits: Array<true> = [];
  const live: Array<boolean> = [];
  const session = createTerminalSession(
    {
      attach: () => attachment,
      observe: () => observation,
      open: command("open"),
      resize: command("resize"),
      write,
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
  return {
    session,
    attached,
    access,
    flush,
    detach,
    emit,
    observe,
    mount,
    calls,
    of,
    exits,
    live,
    completeCommands,
  };
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

it("writes the launch's initial input once, after the measured resize lands", async () => {
  const resize = Promise.withResolvers<void>();
  const latestResize = Promise.withResolvers<void>();
  const written = Promise.withResolvers<void>();
  let shellCols = 80;
  let resizes = 0;
  const commandWidths: number[] = [];
  const { session, attached, emit, mount, calls, of, completeCommands } = setup({
    initialInput: "stty size\r",
    beforeCommand: async (name, input) => {
      if (name === "resize") {
        await (++resizes === 1 ? resize : latestResize).promise;
        if ("cols" in input && input.cols !== undefined) shellCols = input.cols;
      }
      if (name === "write" && "data" in input && input.data === "stty size\r") {
        commandWidths.push(shellCols);
        written.resolve();
      }
    },
  });
  mount(attached);
  emit({ status: "running", version: 1 });
  emit({ status: "running", version: 2 });
  session.reportGridSize({ cols: 100, rows: 30 });
  resize.resolve();
  await completeCommands(1);
  expect(of("write")).toEqual([{ threadId, terminalId: "term-1", data: "typed" }]);
  latestResize.resolve();
  await written.promise;
  expect(commandWidths).toEqual([100]);
  expect(of("write")).toEqual([
    { threadId, terminalId: "term-1", data: "typed" },
    { threadId, terminalId: "term-1", data: "stty size\r" },
  ]);
  expect(calls.map((call) => call.command)).toEqual(["resize", "resize", "write", "write"]);
});

it.each(["failed resize", "starting snapshot", "unmeasured grid"] as const)(
  "keeps launch input pending after a %s until a running shell is successfully resized",
  async (scenario) => {
    let failResize = scenario === "failed resize";
    const written = Promise.withResolvers<void>();
    const { session, attached, emit, mount, of, completeCommands } = setup({
      initialInput: "pnpm dev\r",
      resizeFailure: () => failResize,
      beforeCommand: async (name, input) => {
        if (name === "write" && "data" in input && input.data === "pnpm dev\r") written.resolve();
      },
    });
    // The seeded grid is 120x40; only "unmeasured grid" never hears from the surface.
    if (scenario !== "unmeasured grid") session.reportGridSize({ cols: 120, rows: 40 });
    mount(attached);
    emit({ status: scenario === "starting snapshot" ? "starting" : "running", version: 1 });
    await completeCommands();
    expect(of("write")).toEqual([{ threadId, terminalId: "term-1", data: "typed" }]);
    expect(of("resize")).toHaveLength(scenario === "starting snapshot" ? 0 : 1);

    failResize = false;
    session.reportGridSize(
      scenario === "unmeasured grid" ? { cols: 120, rows: 40 } : { cols: 100, rows: 30 },
    );
    emit({ status: "running", version: 2 });
    await written.promise;
    emit({ status: "running", version: 3 });
    await completeCommands();
    expect(of("write")).toEqual([
      { threadId, terminalId: "term-1", data: "typed" },
      { threadId, terminalId: "term-1", data: "pnpm dev\r" },
      { threadId, terminalId: "term-1", data: "typed" },
    ]);
  },
);

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

it("keeps one attached driver, so a remount before release keeps its state", () => {
  const { session, attached, flush, emit, mount, of, exits } = setup();
  const driver = session.driver(attached);
  expect(session.driver({ ...attached })).toBe(driver);
  const unmountFirst = mount(attached);
  emit({ status: "running", version: 1 });
  // A brief disconnect unmounts and remounts the driver before its release runs.
  unmountFirst();
  mount(attached);
  flush();
  emit({ status: "exited", version: 2 });
  expect(of("close")).toHaveLength(1);
  expect(exits).toHaveLength(1);
});

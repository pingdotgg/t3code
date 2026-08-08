import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  TerminalSessionLookupError,
  ThreadId,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
} from "@t3tools/contracts";
import { getTerminalLabel, nextTerminalId } from "@t3tools/shared/terminalLabels";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  boundTerminalOutput,
  stripTerminalControlSequences,
  terminalToolkitHandlers,
} from "./handlers.ts";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

interface StubSession {
  readonly threadId: string;
  readonly terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  history: string;
  hasRunningSubprocess: boolean;
}

interface StubTerminalManager {
  readonly service: TerminalManager.TerminalManager["Service"];
  readonly writes: ReadonlyArray<{ readonly terminalId: string; readonly data: string }>;
  readonly emitOutput: (threadId: string, terminalId: string, data: string) => Effect.Effect<void>;
  readonly markExited: (threadId: string, terminalId: string) => void;
  /** Unnamed opens must delegate id allocation to the manager's locked path. */
  readonly allocatedByManager: number;
  readonly openedByName: ReadonlyArray<string>;
  readonly setSubprocess: (
    threadId: string,
    terminalId: string,
    running: boolean,
  ) => Effect.Effect<void>;
}

/**
 * In-memory stand-in for `TerminalManager`. The MCP toolkit is a thin wrapper,
 * so the tests drive session state and activity directly instead of spawning
 * real PTYs.
 */
const makeStubTerminalManager = (): StubTerminalManager => {
  const sessions = new Map<string, StubSession>();
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const writes: Array<{ readonly terminalId: string; readonly data: string }> = [];
  const openedByName: Array<string> = [];
  const counters = { allocatedByManager: 0 };
  const key = (threadId: string, terminalId: string) => `${threadId} ${terminalId}`;

  const summaryOf = (session: StubSession): TerminalSummary => ({
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: 4242,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: session.hasRunningSubprocess,
    label: getTerminalLabel(session.terminalId),
    updatedAt: UPDATED_AT,
  });

  const snapshotOf = (session: StubSession): TerminalSessionSnapshot => ({
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: 4242,
    history: session.history,
    exitCode: null,
    exitSignal: null,
    label: getTerminalLabel(session.terminalId),
    updatedAt: UPDATED_AT,
  });

  const publish = (event: TerminalEvent) =>
    Effect.forEach([...listeners], (listener) => listener(event), { discard: true });

  const openByName = (name: string) => {
    openedByName.push(name);
  };

  const open: TerminalManager.TerminalManager["Service"]["open"] = Effect.fn("stub.open")(
    function* (input) {
      openByName(input.terminalId);
      const existing = sessions.get(key(input.threadId, input.terminalId));
      const session: StubSession = existing ?? {
        threadId: input.threadId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "running",
        history: "",
        hasRunningSubprocess: false,
      };
      sessions.set(key(input.threadId, input.terminalId), session);
      const snapshot = snapshotOf(session);
      yield* publish({
        type: "started",
        threadId: session.threadId,
        terminalId: session.terminalId,
        snapshot,
      });
      return snapshot;
    },
  );

  const attachStream: TerminalManager.TerminalManager["Service"]["attachStream"] = (
    input,
    listener,
  ) =>
    Effect.gen(function* () {
      const session = sessions.get(key(input.threadId, input.terminalId));
      if (!session) {
        return yield* new TerminalSessionLookupError({
          threadId: input.threadId,
          terminalId: input.terminalId,
        });
      }
      yield* listener({ type: "snapshot", snapshot: snapshotOf(session) });
      const forward = (event: TerminalEvent) =>
        event.type === "output" &&
        event.threadId === input.threadId &&
        event.terminalId === input.terminalId
          ? listener(event)
          : Effect.void;
      listeners.add(forward);
      return () => {
        listeners.delete(forward);
      };
    });

  const appendOutput = Effect.fn("stub.appendOutput")(function* (
    threadId: string,
    terminalId: string,
    data: string,
  ) {
    const session = sessions.get(key(threadId, terminalId));
    if (!session) return;
    session.history += data;
    yield* publish({ type: "output", threadId, terminalId, data });
  });

  const write: TerminalManager.TerminalManager["Service"]["write"] = Effect.fn("stub.write")(
    function* (input) {
      const session = sessions.get(key(input.threadId, input.terminalId));
      if (!session) {
        return yield* new TerminalSessionLookupError({
          threadId: input.threadId,
          terminalId: input.terminalId,
        });
      }
      writes.push({ terminalId: input.terminalId, data: input.data });
      yield* appendOutput(input.threadId, input.terminalId, input.data);
    },
  );

  const clear: TerminalManager.TerminalManager["Service"]["clear"] = Effect.fn("stub.clear")(
    function* (input) {
      const session = sessions.get(key(input.threadId, input.terminalId));
      if (!session) return;
      session.history = "";
      yield* publish({
        type: "cleared",
        threadId: input.threadId,
        terminalId: input.terminalId,
      });
    },
  );

  const restart: TerminalManager.TerminalManager["Service"]["restart"] = Effect.fn("stub.restart")(
    function* (input) {
      const session = sessions.get(key(input.threadId, input.terminalId));
      if (!session) {
        return yield* new TerminalSessionLookupError({
          threadId: input.threadId,
          terminalId: input.terminalId,
        });
      }
      session.history = "";
      session.cwd = input.cwd;
      session.status = "running";
      const snapshot = snapshotOf(session);
      yield* publish({
        type: "restarted",
        threadId: input.threadId,
        terminalId: input.terminalId,
        snapshot,
      });
      return snapshot;
    },
  );

  const close: TerminalManager.TerminalManager["Service"]["close"] = Effect.fn("stub.close")(
    function* (input) {
      const targets = [...sessions.values()].filter(
        (session) =>
          session.threadId === input.threadId &&
          (input.terminalId === undefined || session.terminalId === input.terminalId),
      );
      for (const session of targets) {
        sessions.delete(key(session.threadId, session.terminalId));
        yield* publish({
          type: "closed",
          threadId: session.threadId,
          terminalId: session.terminalId,
        });
      }
    },
  );

  const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });

  const subscribeMetadata: TerminalManager.TerminalManager["Service"]["subscribeMetadata"] = (
    listener,
  ) =>
    Effect.gen(function* () {
      yield* listener({
        type: "snapshot",
        terminals: [...sessions.values()].map(summaryOf),
      });
      const forward = (event: TerminalEvent) => {
        if (event.type === "closed") {
          return listener({
            type: "remove",
            threadId: event.threadId,
            terminalId: event.terminalId,
          });
        }
        if (event.type === "output" || event.type === "cleared") return Effect.void;
        const session = sessions.get(key(event.threadId, event.terminalId));
        return session ? listener({ type: "upsert", terminal: summaryOf(session) }) : Effect.void;
      };
      listeners.add(forward);
      return () => {
        listeners.delete(forward);
      };
    });

  const readAllTerminalMetadata: TerminalManager.TerminalManager["Service"]["readAllTerminalMetadata"] =
    () => Effect.succeed([...sessions.values()].map(summaryOf));

  const readTerminalMetadata: TerminalManager.TerminalManager["Service"]["readTerminalMetadata"] = (
    input,
  ) => {
    const session = sessions.get(key(input.threadId, input.terminalId));
    return Effect.succeed(session ? summaryOf(session) : null);
  };

  const readTerminalSnapshot: TerminalManager.TerminalManager["Service"]["readTerminalSnapshot"] = (
    input,
  ) => {
    const session = sessions.get(key(input.threadId, input.terminalId));
    return Effect.succeed(session ? snapshotOf(session) : null);
  };

  const openNewTerminal: TerminalManager.TerminalManager["Service"]["openNewTerminal"] = (
    input,
  ) => {
    counters.allocatedByManager += 1;
    const before = openedByName.length;
    const used = [...sessions.values()]
      .filter((session) => session.threadId === input.threadId)
      .map((session) => session.terminalId);
    return open({ ...input, terminalId: nextTerminalId(used) }).pipe(
      Effect.tap(() => Effect.sync(() => openedByName.splice(before))),
    );
  };

  return {
    service: TerminalManager.TerminalManager.of({
      open,
      openNewTerminal,
      attachStream,
      write,
      resize: () => Effect.void,
      clear,
      restart,
      close,
      subscribe,
      subscribeMetadata,
      readAllTerminalMetadata,
      readTerminalMetadata,
      readTerminalSnapshot,
    }),
    writes,
    get allocatedByManager() {
      return counters.allocatedByManager;
    },
    openedByName,
    emitOutput: appendOutput,
    markExited: (threadId: string, terminalId: string) => {
      const session = sessions.get(key(threadId, terminalId));
      if (session) session.status = "exited";
    },
    setSubprocess: Effect.fn("stub.setSubprocess")(function* (threadId, terminalId, running) {
      const session = sessions.get(key(threadId, terminalId));
      if (!session) return;
      session.hasRunningSubprocess = running;
      yield* publish({
        type: "activity",
        threadId,
        terminalId,
        hasRunningSubprocess: running,
        label: getTerminalLabel(terminalId),
      });
    }),
  };
};

const invocationFor = (threadId: string): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-terminal-test"),
  threadId: ThreadId.make(threadId),
  providerSessionId: "provider-session-terminal-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
});

const runAs = <A, E>(
  threadId: string,
  stub: StubTerminalManager,
  effect: Effect.Effect<
    A,
    E,
    McpInvocationContext.McpInvocationContext | TerminalManager.TerminalManager
  >,
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocationFor(threadId)),
    Effect.provideService(TerminalManager.TerminalManager, stub.service),
  );

it.effect("opens a terminal, submits a command, and reads the output back", () =>
  Effect.gen(function* () {
    const stub = makeStubTerminalManager();
    const opened = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_open({ cwd: "/repo", worktreePath: "/repo/wt" }),
    );
    expect(opened.terminalId).toBe("term-1");
    expect(opened.terminal.cwd).toBe("/repo");
    expect(opened.terminal.worktreePath).toBe("/repo/wt");

    const written = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_write({ terminalId: "term-1", data: "pnpm test" }),
    );
    expect(written.submitted).toBe(true);
    expect(stub.writes).toEqual([{ terminalId: "term-1", data: "pnpm test\r" }]);

    yield* stub.emitOutput("thread-a", "term-1", "\n3 passed\n");
    const read = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_read({ terminalId: "term-1" }),
    );
    expect(read.output).toBe("pnpm test\n3 passed\n");
    expect(read.truncated).toBe(false);
    expect(read.hasRunningSubprocess).toBe(false);
  }),
);

it.effect("allocates the lowest free terminal id and reattaches to a named one", () =>
  Effect.gen(function* () {
    const stub = makeStubTerminalManager();
    const first = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_open({ cwd: "/repo" }),
    );
    const second = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_open({ cwd: "/repo" }),
    );
    const reattached = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_open({ cwd: "/repo", terminalId: "term-1" }),
    );
    expect([first.terminalId, second.terminalId, reattached.terminalId]).toEqual([
      "term-1",
      "term-2",
      "term-1",
    ]);

    const listed = yield* runAs("thread-a", stub, terminalToolkitHandlers.terminal_list());
    expect(listed.terminals.map((terminal) => terminal.terminalId).sort()).toEqual([
      "term-1",
      "term-2",
    ]);
  }),
);

it.effect("delegates id allocation for an unnamed open to the manager", () =>
  Effect.gen(function* () {
    const stub = makeStubTerminalManager();
    yield* runAs("thread-a", stub, terminalToolkitHandlers.terminal_open({ cwd: "/repo" }));

    // Choosing the id here instead would race a concurrent open: both callers
    // would read the same roster, pick the same free id, and the second would
    // reattach to the first session. Only the manager can allocate under its
    // thread lock, so an unnamed open must go through openNewTerminal.
    expect(stub.allocatedByManager).toBe(1);
    expect(stub.openedByName).toEqual([]);

    yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_open({ cwd: "/repo", terminalId: "term-9" }),
    );
    expect(stub.allocatedByManager).toBe(1);
    expect(stub.openedByName).toEqual(["term-9"]);
  }),
);

it.effect("refuses to report a write as submitted once the shell has exited", () =>
  Effect.gen(function* () {
    const stub = makeStubTerminalManager();
    yield* runAs("thread-a", stub, terminalToolkitHandlers.terminal_open({ cwd: "/repo" }));
    stub.markExited("thread-a", "term-1");

    // TerminalManager.write is a deliberate no-op for an exited session, so a
    // blind write would tell the agent a command ran when nothing received it.
    const result = yield* Effect.exit(
      runAs(
        "thread-a",
        stub,
        terminalToolkitHandlers.terminal_write({ terminalId: "term-1", data: "ls" }),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(stub.writes).toHaveLength(0);
  }),
);

it.effect("leaves input unsubmitted when submit is false", () =>
  Effect.gen(function* () {
    const stub = makeStubTerminalManager();
    yield* runAs("thread-a", stub, terminalToolkitHandlers.terminal_open({ cwd: "/repo" }));
    const written = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_write({
        terminalId: "term-1",
        data: "\u0003",
        submit: false,
      }),
    );
    expect(written.submitted).toBe(false);
    expect(stub.writes).toEqual([{ terminalId: "term-1", data: "\u0003" }]);
  }),
);

it.effect("bounds read output to the requested trailing lines", () =>
  Effect.gen(function* () {
    const stub = makeStubTerminalManager();
    yield* runAs("thread-a", stub, terminalToolkitHandlers.terminal_open({ cwd: "/repo" }));
    yield* stub.emitOutput(
      "thread-a",
      "term-1",
      Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\n"),
    );

    const bounded = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_read({ terminalId: "term-1", lines: 3 }),
    );
    expect(bounded.output).toBe("line-7\nline-8\nline-9");
    expect(bounded.lines).toBe(3);
    expect(bounded.truncated).toBe(true);
  }),
);

it.effect("reports idle once the terminal has been quiet for the settle window", () =>
  Effect.gen(function* () {
    const stub = makeStubTerminalManager();
    yield* runAs("thread-a", stub, terminalToolkitHandlers.terminal_open({ cwd: "/repo" }));
    yield* stub.setSubprocess("thread-a", "term-1", true);

    const waiting = yield* Effect.forkChild(
      runAs(
        "thread-a",
        stub,
        terminalToolkitHandlers.terminal_wait({
          terminalId: "term-1",
          timeoutMs: 30_000,
          quietMs: 1_500,
        }),
      ),
    );
    yield* TestClock.adjust("5000 millis");
    yield* stub.setSubprocess("thread-a", "term-1", false);
    yield* TestClock.adjust("1500 millis");

    const result = yield* Fiber.join(waiting);
    expect(result.idle).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.terminal?.hasRunningSubprocess).toBe(false);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("gives up at the timeout while a subprocess is still running", () =>
  Effect.gen(function* () {
    const stub = makeStubTerminalManager();
    yield* runAs("thread-a", stub, terminalToolkitHandlers.terminal_open({ cwd: "/repo" }));
    yield* stub.setSubprocess("thread-a", "term-1", true);

    const waiting = yield* Effect.forkChild(
      runAs(
        "thread-a",
        stub,
        terminalToolkitHandlers.terminal_wait({
          terminalId: "term-1",
          timeoutMs: 5_000,
          quietMs: 1_500,
        }),
      ),
    );
    yield* TestClock.adjust("5000 millis");

    const result = yield* Fiber.join(waiting);
    expect(result.timedOut).toBe(true);
    expect(result.idle).toBe(false);
    expect(result.terminal?.hasRunningSubprocess).toBe(true);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("fails to wait on a terminal that does not exist", () =>
  Effect.gen(function* () {
    const stub = makeStubTerminalManager();
    const error = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_wait({ terminalId: "term-9" }),
    ).pipe(Effect.flip);
    expect(error._tag).toBe("TerminalSessionLookupError");
  }),
);

it.effect("never reaches a terminal owned by another thread", () =>
  Effect.gen(function* () {
    const stub = makeStubTerminalManager();
    yield* stub.service.open({ threadId: "thread-b", terminalId: "term-1", cwd: "/repo-b" });

    const listed = yield* runAs("thread-a", stub, terminalToolkitHandlers.terminal_list());
    expect(listed.terminals).toEqual([]);

    const readError = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_read({ terminalId: "term-1" }),
    ).pipe(Effect.flip);
    expect(readError).toMatchObject({
      _tag: "TerminalSessionLookupError",
      threadId: "thread-a",
    });

    const writeError = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_write({ terminalId: "term-1", data: "rm -rf /" }),
    ).pipe(Effect.flip);
    expect(writeError._tag).toBe("TerminalSessionLookupError");
    expect(stub.writes).toEqual([]);

    const closed = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_close({ terminalId: "term-1" }),
    );
    expect(closed.closed).toBe(false);

    const survivors = yield* runAs("thread-b", stub, terminalToolkitHandlers.terminal_list());
    expect(survivors.terminals.map((terminal) => terminal.terminalId)).toEqual(["term-1"]);
  }),
);

it.effect("closes a terminal once and then reports it as already gone", () =>
  Effect.gen(function* () {
    const stub = makeStubTerminalManager();
    yield* runAs("thread-a", stub, terminalToolkitHandlers.terminal_open({ cwd: "/repo" }));

    const first = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_close({ terminalId: "term-1" }),
    );
    const second = yield* runAs(
      "thread-a",
      stub,
      terminalToolkitHandlers.terminal_close({ terminalId: "term-1" }),
    );
    expect([first.closed, second.closed]).toEqual([true, false]);
  }),
);

it("keeps only the final text of lines the shell rewrote in place", () => {
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  expect(stripTerminalControlSequences(`${esc}[32mgreen${esc}[0m\n`)).toBe("green\n");
  expect(stripTerminalControlSequences("10%\r55%\r100%\ndone\n")).toBe("100%\ndone\n");
  expect(stripTerminalControlSequences(`${esc}]0;title${bel}prompt$ `)).toBe("prompt$ ");
});

it("caps output at the absolute character ceiling", () => {
  const oversized = "x".repeat(40_000);
  const bounded = boundTerminalOutput(oversized, 5_000);
  expect(bounded.output.length).toBe(32_000);
  expect(bounded.truncated).toBe(true);
  expect(boundTerminalOutput("a\nb", 5_000)).toEqual({
    output: "a\nb",
    lines: 2,
    truncated: false,
  });
});

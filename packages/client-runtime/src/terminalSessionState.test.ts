import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it } from "vitest";

import {
  EnvironmentId,
  TerminalAttachStreamEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";

import {
  createTerminalSessionManager,
  getKnownTerminalSessionListFilter,
  knownTerminalSessionsAtom,
  runningTerminalIdsAtom,
  terminalSessionStateAtom,
  type KnownTerminalSessionTarget,
} from "./terminalSessionState.ts";

let atomRegistry = AtomRegistry.make();

function resetAtomRegistry() {
  atomRegistry.dispose();
  atomRegistry = AtomRegistry.make();
}

const TARGET = {
  environmentId: EnvironmentId.make("env-local"),
  threadId: ThreadId.make("thread-1"),
  terminalId: "term-1",
} as const;

const BASE_SNAPSHOT: TerminalSessionSnapshot = {
  threadId: TARGET.threadId,
  terminalId: TARGET.terminalId,
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 123,
  history: "hello",
  exitCode: null,
  exitSignal: null,
  label: "Terminal 1",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

type TerminalSessionManager = ReturnType<typeof createTerminalSessionManager>;

function applyAttachEvents(
  manager: TerminalSessionManager,
  target: KnownTerminalSessionTarget,
  events: ReadonlyArray<TerminalAttachStreamEvent>,
): void {
  manager.attach({
    environmentId: target.environmentId,
    terminal: {
      threadId: target.threadId,
      terminalId: target.terminalId,
    },
    client: {
      terminal: {
        attach: (_input, listener) => {
          events.forEach(listener);
          return () => undefined;
        },
      },
    },
  })();
}

function applyMetadataEvents(
  manager: TerminalSessionManager,
  environmentId: EnvironmentId,
  events: ReadonlyArray<TerminalMetadataStreamEvent>,
): void {
  manager.subscribeMetadata({
    environmentId,
    client: {
      terminal: {
        onMetadata: (listener) => {
          events.forEach(listener);
          return () => undefined;
        },
      },
    },
  })();
}

describe("createTerminalSessionManager", () => {
  afterEach(() => {
    resetAtomRegistry();
  });

  it("hydrates from started snapshots and appends output events", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    applyAttachEvents(manager, TARGET, [
      {
        type: "snapshot",
        snapshot: BASE_SNAPSHOT,
      },
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: " world",
      },
    ]);

    expect(manager.getSnapshot(TARGET)).toMatchObject({
      summary: null,
      buffer: "hello world",
      status: "running",
      error: null,
      updatedAt: BASE_SNAPSHOT.updatedAt,
    });
  });

  it("caps retained output", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
      maxBufferBytes: 5,
    });

    applyAttachEvents(manager, TARGET, [
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "abcdef",
      },
    ]);

    expect(manager.getSnapshot(TARGET).buffer).toBe("bcdef");
  });

  it("caps retained output by utf-8 byte length", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
      maxBufferBytes: 4,
    });

    applyAttachEvents(manager, TARGET, [
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "🙂🙂",
      },
    ]);

    expect(manager.getSnapshot(TARGET).buffer).toBe("🙂");
  });

  it("invalidates one environment without clearing others", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });
    const otherTarget = {
      environmentId: EnvironmentId.make("env-remote"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-1",
    } as const;

    for (const target of [TARGET, otherTarget]) {
      applyAttachEvents(manager, target, [
        {
          type: "output",
          threadId: target.threadId,
          terminalId: target.terminalId,
          data: target.environmentId,
        },
      ]);
    }

    manager.invalidateEnvironment(TARGET.environmentId);

    expect(manager.getSnapshot(TARGET).buffer).toBe("");
    expect(manager.getSnapshot(otherTarget).buffer).toBe("env-remote");
  });

  it("lists known sessions for a thread ordered by terminal id (numeric-aware)", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    applyMetadataEvents(manager, TARGET.environmentId, [
      {
        type: "snapshot",
        terminals: [
          {
            threadId: TARGET.threadId,
            terminalId: "term-10",
            cwd: "/repo",
            worktreePath: null,
            status: "running",
            pid: 125,
            exitCode: null,
            exitSignal: null,
            updatedAt: "2026-04-01T00:00:05.000Z",
            hasRunningSubprocess: false,
            label: "Terminal 10",
          },
          {
            threadId: TARGET.threadId,
            terminalId: TARGET.terminalId,
            cwd: "/repo",
            worktreePath: null,
            status: "running",
            pid: 123,
            exitCode: null,
            exitSignal: null,
            updatedAt: "2026-04-01T00:00:00.000Z",
            hasRunningSubprocess: false,
            label: "Terminal 1",
          },
          {
            threadId: TARGET.threadId,
            terminalId: "term-2",
            cwd: "/repo",
            worktreePath: null,
            status: "running",
            pid: 124,
            exitCode: null,
            exitSignal: null,
            updatedAt: "2026-04-01T00:00:02.000Z",
            hasRunningSubprocess: false,
            label: "Terminal 2",
          },
        ],
      },
    ]);

    expect(
      manager
        .listSessions({
          environmentId: TARGET.environmentId,
          threadId: TARGET.threadId,
        })
        .map((session) => session.target.terminalId),
    ).toEqual(["term-1", "term-2", "term-10"]);
  });

  it("drops known sessions when an environment is invalidated", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    applyAttachEvents(manager, TARGET, [
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "hello",
      },
    ]);

    manager.invalidateEnvironment(TARGET.environmentId);

    expect(
      manager.listSessions({
        environmentId: TARGET.environmentId,
        threadId: TARGET.threadId,
      }),
    ).toEqual([]);
  });

  it("removes closed sessions from the known-session index while keeping local closed state", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    applyMetadataEvents(manager, TARGET.environmentId, [
      {
        type: "upsert",
        terminal: {
          threadId: TARGET.threadId,
          terminalId: TARGET.terminalId,
          cwd: "/repo",
          worktreePath: null,
          status: "running",
          pid: 123,
          exitCode: null,
          exitSignal: null,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: "Terminal 1",
        },
      },
    ]);
    applyAttachEvents(manager, TARGET, [
      {
        type: "snapshot",
        snapshot: BASE_SNAPSHOT,
      },
      {
        type: "closed",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
      },
    ]);
    applyMetadataEvents(manager, TARGET.environmentId, [
      {
        type: "remove",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
      },
    ]);

    expect(
      manager.listSessions({
        environmentId: TARGET.environmentId,
        threadId: TARGET.threadId,
      }),
    ).toEqual([]);
    expect(manager.getSnapshot(TARGET)).toMatchObject({
      buffer: "hello",
      status: "closed",
      summary: null,
      updatedAt: BASE_SNAPSHOT.updatedAt,
    });
  });

  it("clears locally retained closed state on reset", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    applyAttachEvents(manager, TARGET, [
      {
        type: "snapshot",
        snapshot: BASE_SNAPSHOT,
      },
      {
        type: "closed",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
      },
    ]);

    manager.reset();

    expect(manager.getSnapshot(TARGET)).toEqual({
      summary: null,
      buffer: "",
      status: "closed",
      error: null,
      hasRunningSubprocess: false,
      updatedAt: null,
      version: 0,
    });
  });

  it("syncs snapshots returned from open calls immediately", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    applyAttachEvents(manager, TARGET, [
      {
        type: "snapshot",
        snapshot: {
          ...BASE_SNAPSHOT,
          history: "prompt$ ",
          updatedAt: "2026-04-01T00:00:03.000Z",
        },
      },
    ]);

    expect(manager.getSnapshot(TARGET)).toMatchObject({
      buffer: "prompt$ ",
      status: "running",
      updatedAt: "2026-04-01T00:00:03.000Z",
    });
  });

  it("syncs authoritative metadata snapshots and removes missing environment terminals", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    applyAttachEvents(manager, TARGET, [
      {
        type: "snapshot",
        snapshot: BASE_SNAPSHOT,
      },
    ]);
    applyAttachEvents(
      manager,
      {
        environmentId: TARGET.environmentId,
        threadId: TARGET.threadId,
        terminalId: "term-2",
      },
      [
        {
          type: "snapshot",
          snapshot: {
            ...BASE_SNAPSHOT,
            terminalId: "term-2",
            label: "Terminal 2",
            updatedAt: "2026-04-01T00:00:02.000Z",
          },
        },
      ],
    );

    applyMetadataEvents(manager, TARGET.environmentId, [
      {
        type: "snapshot",
        terminals: [
          {
            threadId: TARGET.threadId,
            terminalId: "term-2",
            cwd: "/repo",
            worktreePath: null,
            status: "running",
            pid: 123,
            exitCode: null,
            exitSignal: null,
            updatedAt: "2026-04-01T00:00:05.000Z",
            hasRunningSubprocess: true,
            label: "Terminal 2",
          },
        ],
      },
    ]);

    expect(
      manager.listSessions({
        environmentId: TARGET.environmentId,
        threadId: TARGET.threadId,
      }),
    ).toMatchObject([
      {
        target: {
          environmentId: TARGET.environmentId,
          threadId: TARGET.threadId,
          terminalId: "term-2",
        },
        state: {
          summary: {
            terminalId: "term-2",
            cwd: "/repo",
          },
          hasRunningSubprocess: true,
        },
      },
    ]);
  });

  it("updates listed session metadata when existing session activity changes", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    applyMetadataEvents(manager, TARGET.environmentId, [
      {
        type: "upsert",
        terminal: {
          threadId: TARGET.threadId,
          terminalId: TARGET.terminalId,
          cwd: "/repo",
          worktreePath: null,
          status: "running",
          pid: 123,
          exitCode: null,
          exitSignal: null,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: "Terminal 1",
        },
      },
    ]);

    applyMetadataEvents(manager, TARGET.environmentId, [
      {
        type: "upsert",
        terminal: {
          threadId: TARGET.threadId,
          terminalId: TARGET.terminalId,
          cwd: "/repo",
          worktreePath: null,
          status: "running",
          pid: 123,
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-04-01T00:00:05.000Z",
          hasRunningSubprocess: true,
          label: "Terminal 1",
        },
      },
    ]);

    expect(
      manager.listSessions({ environmentId: TARGET.environmentId, threadId: TARGET.threadId }),
    ).toMatchObject([
      {
        state: {
          hasRunningSubprocess: true,
        },
      },
    ]);
  });

  it("derives session atoms from structurally equal target objects", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    applyMetadataEvents(manager, TARGET.environmentId, [
      {
        type: "upsert",
        terminal: {
          threadId: TARGET.threadId,
          terminalId: TARGET.terminalId,
          cwd: "/repo",
          worktreePath: null,
          status: "running",
          pid: 123,
          exitCode: null,
          exitSignal: null,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: true,
          label: "Terminal 1",
        },
      },
    ]);
    applyAttachEvents(manager, TARGET, [
      {
        type: "snapshot",
        snapshot: BASE_SNAPSHOT,
      },
    ]);

    const equalTarget = { ...TARGET };
    const filter = getKnownTerminalSessionListFilter({
      environmentId: TARGET.environmentId,
      threadId: TARGET.threadId,
    });
    expect(filter).not.toBeNull();
    if (filter === null) {
      return;
    }

    expect(atomRegistry.get(terminalSessionStateAtom(equalTarget))).toMatchObject({
      buffer: BASE_SNAPSHOT.history,
      hasRunningSubprocess: true,
    });
    expect(
      atomRegistry.get(knownTerminalSessionsAtom({ ...filter })).map((session) => session.target),
    ).toEqual([TARGET]);
    expect(atomRegistry.get(runningTerminalIdsAtom({ ...filter }))).toEqual([TARGET.terminalId]);
  });
});

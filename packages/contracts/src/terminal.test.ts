import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_ID,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalThreadInput,
  TerminalWriteInput,
} from "./terminal.ts";

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

describe("TerminalOpenInput", () => {
  it("accepts valid open input", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        cwd: "/tmp/project",
        cols: 120,
        rows: 40,
      }),
    ).toBe(true);
  });

  it("accepts ultrawide terminal dimensions from xterm fit", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        cwd: "/tmp/project",
        cols: 423,
        rows: 40,
      }),
    ).toBe(true);
  });

  it("rejects invalid bounds", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        cwd: "/tmp/project",
        cols: 10,
        rows: 0,
      }),
    ).toBe(false);
  });

  it("defaults terminalId when missing", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      threadId: "thread-1",
      cwd: "/tmp/project",
      cols: 100,
      rows: 24,
    });
    expect(parsed.terminalId).toBe(DEFAULT_TERMINAL_ID);
  });

  it("accepts optional env overrides", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      threadId: "thread-1",
      cwd: "/tmp/project",
      worktreePath: "/tmp/project/.t3/worktrees/feature-a",
      cols: 100,
      rows: 24,
      env: {
        T3CODE_PROJECT_ROOT: "/tmp/project",
        CUSTOM_FLAG: "1",
      },
    });
    expect(parsed.env).toMatchObject({
      T3CODE_PROJECT_ROOT: "/tmp/project",
      CUSTOM_FLAG: "1",
    });
    expect(parsed.worktreePath).toBe("/tmp/project/.t3/worktrees/feature-a");
  });

  it("rejects invalid env keys", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        cwd: "/tmp/project",
        cols: 100,
        rows: 24,
        env: {
          "bad-key": "1",
        },
      }),
    ).toBe(false);
  });
});

describe("TerminalWriteInput", () => {
  it("accepts non-empty data", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        data: "echo hello\n",
      }),
    ).toBe(true);
  });

  it("rejects empty data", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        data: "",
      }),
    ).toBe(false);
  });
});

describe("TerminalThreadInput", () => {
  it("trims thread ids", () => {
    const parsed = decodeSync(TerminalThreadInput, { threadId: " thread-1 " });
    expect(parsed.threadId).toBe("thread-1");
  });
});

describe("TerminalResizeInput", () => {
  it("accepts valid size", () => {
    expect(
      decodes(TerminalResizeInput, {
        threadId: "thread-1",
        cols: 80,
        rows: 24,
      }),
    ).toBe(true);
  });
});

describe("TerminalClearInput", () => {
  it("defaults terminal id", () => {
    const parsed = decodeSync(TerminalClearInput, {
      threadId: "thread-1",
    });
    expect(parsed.terminalId).toBe(DEFAULT_TERMINAL_ID);
  });
});

describe("TerminalCloseInput", () => {
  it("accepts optional deleteHistory", () => {
    expect(
      decodes(TerminalCloseInput, {
        threadId: "thread-1",
        deleteHistory: true,
      }),
    ).toBe(true);
  });
});

describe("TerminalSessionSnapshot", () => {
  const isoTimestamp = "2026-01-01T00:00:00.000Z";

  it("accepts running snapshots", () => {
    expect(
      decodes(TerminalSessionSnapshot, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        worktreePath: null,
        status: "running",
        pid: 1234,
        history: "hello\n",
        exitCode: null,
        exitSignal: null,
        updatedAt: isoTimestamp,
      }),
    ).toBe(true);
  });
});

describe("TerminalEvent", () => {
  const isoTimestamp = "2026-01-01T00:00:00.000Z";

  it("accepts output events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "output",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        createdAt: isoTimestamp,
        data: "line\n",
      }),
    ).toBe(true);
  });

  it("accepts exited events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "exited",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        createdAt: isoTimestamp,
        exitCode: 0,
        exitSignal: null,
      }),
    ).toBe(true);
  });

  it("accepts activity events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "activity",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        createdAt: isoTimestamp,
        hasRunningSubprocess: true,
      }),
    ).toBe(true);
  });

  it("accepts started events with snapshot worktree metadata", () => {
    expect(
      decodes(TerminalEvent, {
        type: "started",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        createdAt: isoTimestamp,
        snapshot: {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: "/tmp/project/.t3/worktrees/feature-a",
          worktreePath: "/tmp/project/.t3/worktrees/feature-a",
          status: "running",
          pid: 1234,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: isoTimestamp,
        },
      }),
    ).toBe(true);
  });
});

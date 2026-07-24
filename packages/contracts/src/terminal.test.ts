import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TERMINAL_ID,
  TerminalAttachInput,
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
        terminalId: DEFAULT_TERMINAL_ID,
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
        terminalId: DEFAULT_TERMINAL_ID,
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
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        cols: 10,
        rows: 0,
      }),
    ).toBe(false);
  });

  it("requires terminalId — the client must always pick an id", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        cwd: "/tmp/project",
        cols: 100,
        rows: 24,
      }),
    ).toBe(false);
  });

  it("accepts optional env overrides", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
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

describe("TerminalAttachInput", () => {
  it("accepts explicit inactive-session restart intent", () => {
    const parsed = decodeSync(TerminalAttachInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      restartIfNotRunning: true,
    });

    expect(parsed.restartIfNotRunning).toBe(true);
  });
});

describe("TerminalWriteInput", () => {
  it("accepts non-empty data", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "echo hello\n",
      }),
    ).toBe(true);
  });

  it("accepts an explicit keyboard input source", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\u001b[?1;2c",
        inputSource: "keyboard",
      }),
    ).toBe(true);
  });

  it("accepts an explicit renderer input source", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\u001b[?1;2c",
        inputSource: "renderer",
      }),
    ).toBe(true);
  });

  it("rejects an unknown input source", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "q",
        inputSource: "automation",
      }),
    ).toBe(false);
  });

  it("rejects empty data", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "",
      }),
    ).toBe(false);
  });

  it("rejects missing terminalId", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        data: "echo hello\n",
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
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 80,
        rows: 24,
      }),
    ).toBe(true);
  });

  it("rejects missing terminalId", () => {
    expect(
      decodes(TerminalResizeInput, {
        threadId: "thread-1",
        cols: 80,
        rows: 24,
      }),
    ).toBe(false);
  });
});

describe("TerminalClearInput", () => {
  it("requires terminalId", () => {
    expect(decodes(TerminalClearInput, { threadId: "thread-1" })).toBe(false);
  });

  it("accepts an explicit terminalId", () => {
    const parsed = decodeSync(TerminalClearInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
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
        label: "Primary",
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
        exitCode: 0,
        exitSignal: null,
      }),
    ).toBe(true);
  });

  it("accepts closed events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "closed",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe(true);
  });

  it("accepts activity events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "activity",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        hasRunningSubprocess: true,
        label: "vim",
      }),
    ).toBe(true);
  });

  it("accepts started events with snapshot worktree metadata", () => {
    expect(
      decodes(TerminalEvent, {
        type: "started",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
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
          label: "Primary",
          updatedAt: isoTimestamp,
        },
      }),
    ).toBe(true);
  });
});

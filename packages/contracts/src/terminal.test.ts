import { describe, expect, it } from "vitest";

import {
  terminalCloseInputSchema,
  terminalEventSchema,
  terminalOpenInputSchema,
  terminalResizeInputSchema,
  terminalSessionSnapshotSchema,
  terminalThreadInputSchema,
  terminalWriteInputSchema,
} from "./terminal";

describe("terminalOpenInputSchema", () => {
  it("accepts valid open input", () => {
    const result = terminalOpenInputSchema.safeParse({
      threadId: "thread-1",
      cwd: "/tmp/project",
      cols: 120,
      rows: 40,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid bounds", () => {
    const result = terminalOpenInputSchema.safeParse({
      threadId: "thread-1",
      cwd: "/tmp/project",
      cols: 10,
      rows: 2,
    });
    expect(result.success).toBe(false);
  });
});

describe("terminalWriteInputSchema", () => {
  it("accepts non-empty data", () => {
    const result = terminalWriteInputSchema.safeParse({
      threadId: "thread-1",
      data: "echo hello\n",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty data", () => {
    const result = terminalWriteInputSchema.safeParse({
      threadId: "thread-1",
      data: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("terminalThreadInputSchema", () => {
  it("trims thread ids", () => {
    const parsed = terminalThreadInputSchema.parse({ threadId: " thread-1 " });
    expect(parsed.threadId).toBe("thread-1");
  });
});

describe("terminalResizeInputSchema", () => {
  it("accepts valid size", () => {
    const result = terminalResizeInputSchema.safeParse({
      threadId: "thread-1",
      cols: 80,
      rows: 24,
    });
    expect(result.success).toBe(true);
  });
});

describe("terminalCloseInputSchema", () => {
  it("accepts optional deleteHistory", () => {
    const result = terminalCloseInputSchema.safeParse({
      threadId: "thread-1",
      deleteHistory: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("terminalSessionSnapshotSchema", () => {
  it("accepts running snapshots", () => {
    const result = terminalSessionSnapshotSchema.safeParse({
      threadId: "thread-1",
      cwd: "/tmp/project",
      status: "running",
      pid: 1234,
      history: "hello\n",
      exitCode: null,
      exitSignal: null,
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

describe("terminalEventSchema", () => {
  it("accepts output events", () => {
    const result = terminalEventSchema.safeParse({
      type: "output",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      data: "line\n",
    });
    expect(result.success).toBe(true);
  });

  it("accepts exited events", () => {
    const result = terminalEventSchema.safeParse({
      type: "exited",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      exitCode: 0,
      exitSignal: null,
    });
    expect(result.success).toBe(true);
  });
});

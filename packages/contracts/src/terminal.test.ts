import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  chunkTerminalWrite,
  DEFAULT_TERMINAL_ID,
  TERMINAL_WRITE_MAX_LENGTH,
  TerminalError,
  TerminalOpenInput,
  TerminalProviderEnvironmentError,
  TerminalSummary,
} from "./terminal.ts";
import { TERMINAL_MCP_MAX_WAIT_MS, TerminalMcpReadInput } from "./terminalMcp.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const encodeTerminalError = Schema.encodeUnknownSync(TerminalError);
const decodeTerminalError = Schema.decodeUnknownSync(TerminalError);

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}

describe("TerminalProviderEnvironmentError", () => {
  it("round-trips its required cause without exposing it in the message", () => {
    const cause = { operation: "read-secret", detail: "secret backend unavailable" };
    const error = new TerminalProviderEnvironmentError({
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      cause,
    });
    const encoded = encodeTerminalError(error);
    const decoded = decodeTerminalError(encoded);

    expect(decoded).toMatchObject({
      _tag: "TerminalProviderEnvironmentError",
      providerInstanceId: "codex_work",
      cause,
    });
    expect(decoded.message).toBe(
      "Could not prepare the terminal environment for provider instance: codex_work",
    );
    expect(decoded.message).not.toContain("secret backend unavailable");
  });
});

describe("TerminalOpenInput", () => {
  it("drops invalid env keys while retaining valid overrides", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      env: { "bad-key": "1", GOOD_KEY: "2" },
    });
    expect(parsed.env).toEqual({ GOOD_KEY: "2" });
  });
});

describe("TerminalSummary", () => {
  const summary = {
    threadId: "thread-1",
    terminalId: "agent-1a2b3c4d",
    cwd: "/tmp/project",
    worktreePath: null,
    status: "running",
    pid: 42,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: "Build",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("decodes summaries from servers without a controller", () => {
    expect(decodeSync(TerminalSummary, summary).controller).toBeUndefined();
    expect(decodeSync(TerminalSummary, { ...summary, controller: "agent" }).controller).toBe(
      "agent",
    );
    expect(() => decodeSync(TerminalSummary, { ...summary, controller: "both" })).toThrow();
  });
});

describe("TerminalMcpReadInput", () => {
  it("caps waits", () => {
    const input = { terminalId: "agent-1a2b3c4d", waitFor: "exit" };
    expect(
      decodeSync(TerminalMcpReadInput, { ...input, timeoutMs: TERMINAL_MCP_MAX_WAIT_MS }),
    ).toMatchObject({ timeoutMs: TERMINAL_MCP_MAX_WAIT_MS });
    expect(() =>
      decodeSync(TerminalMcpReadInput, { ...input, timeoutMs: TERMINAL_MCP_MAX_WAIT_MS + 1 }),
    ).toThrow();
  });
});

describe("chunkTerminalWrite", () => {
  it("splits oversized writes so every chunk fits the contract", () => {
    const chunks = chunkTerminalWrite("y".repeat(TERMINAL_WRITE_MAX_LENGTH * 2 + 5));
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      TERMINAL_WRITE_MAX_LENGTH,
      TERMINAL_WRITE_MAX_LENGTH,
      5,
    ]);
    expect(chunks.join("")).toHaveLength(TERMINAL_WRITE_MAX_LENGTH * 2 + 5);
  });

  it("does not cut a surrogate pair in half at the boundary", () => {
    const data = `${"z".repeat(TERMINAL_WRITE_MAX_LENGTH - 1)}😀tail`;
    const chunks = chunkTerminalWrite(data);
    expect(chunks[0]).toHaveLength(TERMINAL_WRITE_MAX_LENGTH - 1);
    expect(chunks[1]).toBe("😀tail");
    expect(chunks.join("")).toBe(data);
  });
});

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TERMINAL_ID,
  TerminalClearInput,
  TerminalError,
  TerminalOpenInput,
  TerminalProviderEnvironmentError,
  TerminalResizeInput,
  TerminalThreadInput,
  TerminalWriteInput,
} from "./terminal.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const encodeTerminalError = Schema.encodeUnknownSync(TerminalError);
const decodeTerminalError = Schema.decodeUnknownSync(TerminalError);

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

  it("rejects invalid env keys", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      env: {
        "bad-key": "1",
        GOOD_KEY: "1",
      },
    });
    expect(parsed.env).toEqual({ GOOD_KEY: "1" });
  });

  it("rejects invalid provider instance ids", () => {
    for (const providerInstanceId of ["", "1invalid", "invalid id"]) {
      expect(
        decodes(TerminalOpenInput, {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: "/tmp/project",
          providerInstanceId,
        }),
      ).toBe(false);
    }
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
});

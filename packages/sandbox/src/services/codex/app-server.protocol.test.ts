import { describe, expect, test } from "bun:test";

import {
  CODEX_BOOT_SENTINEL,
  consumePtyLines,
  createAppServerBootCommand,
  createCodexHomePath,
  createDeviceAuthBootCommand,
  createPtyFrameState,
  tryExtractDeviceAuthChallenge,
  tryParseJsonRpcLine,
} from "./app-server.protocol";

describe("consumePtyLines", () => {
  test("frames PTY chunks into complete lines", () => {
    const first = consumePtyLines(
      createPtyFrameState(),
      new TextEncoder().encode('{"jsonrpc":"2.0","id":1'),
    );

    expect(first.lines).toEqual([]);

    const second = consumePtyLines(
      first.state,
      new TextEncoder().encode(',"result":{"ok":true}}\nprompt> codex\n'),
    );

    expect(second.lines).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      "prompt> codex",
    ]);
  });
});

describe("tryParseJsonRpcLine", () => {
  test("ignores shell noise and parses responses and notifications", () => {
    expect(tryParseJsonRpcLine("daytona@box:~$ codex app-server")).toBeUndefined();
    expect(tryParseJsonRpcLine('{"jsonrpc":"2.0","id":7,"result":{"type":"apiKey"}}')).toEqual({
      type: "response",
      value: {
        jsonrpc: "2.0",
        id: 7,
        result: { type: "apiKey" },
        error: undefined,
      },
    });
    expect(
      tryParseJsonRpcLine(
        '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thr_1"}}',
      ),
    ).toEqual({
      type: "notification",
      value: {
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: "thr_1" },
      },
    });
  });
});

describe("tryExtractDeviceAuthChallenge", () => {
  test("parses the device auth URL and code from codex login output", () => {
    const output = [
      "\u001B[94mWelcome to Codex\u001B[0m",
      "",
      "1. Open this link in your browser and sign in to your account",
      "   https://auth.openai.com/codex/device",
      "",
      "2. Enter this one-time code (expires in 15 minutes)",
      "   abcd-1234",
    ].join("\n");

    expect(tryExtractDeviceAuthChallenge(output)).toEqual({
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
    });
  });
});

describe("boot command helpers", () => {
  test("pins file-backed auth for app-server and device auth", () => {
    const appServerCommand = createAppServerBootCommand("/workspace/.jevin/codex/demo");
    const deviceAuthCommand = createDeviceAuthBootCommand("/workspace/.jevin/codex/demo");

    expect(appServerCommand).toContain('cli_auth_credentials_store = "file"');
    expect(appServerCommand).toContain(CODEX_BOOT_SENTINEL);
    expect(appServerCommand).toContain("exec codex app-server");

    expect(deviceAuthCommand).toContain('cli_auth_credentials_store = "file"');
    expect(deviceAuthCommand).toContain("exec codex login --device-auth");
  });

  test("derives a stable Codex home path for a sandbox worktree", () => {
    const first = createCodexHomePath("sbx_123", "/workspace/worktrees/openai/demo");
    const second = createCodexHomePath("sbx_123", "/workspace/worktrees/openai/demo");

    expect(first).toBe(second);
  });
});

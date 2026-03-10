import { describe, expect, test } from "bun:test";
import { Sandbox } from "@daytonaio/sdk";
import * as Effect from "effect/Effect";

import type { CreateSandboxOptions } from "../sandbox";
import { makeTerminalService } from "./terminal.layer";

function createFakeSandbox(id: string): Sandbox {
  const sandbox = Object.create(Sandbox.prototype);
  sandbox.id = id;
  sandbox.process = {
    createPty: async () => ({
      sessionId: "pty_123",
      waitForConnection: async () => undefined,
      disconnect: async () => undefined,
      sendInput: async () => undefined,
      resize: async () => undefined,
      wait: async () => ({
        exitCode: 0,
      }),
    }),
  };
  return sandbox;
}

describe("makeTerminalService", () => {
  test("delegates sandbox creation to SandboxService when starting a playground", async () => {
    const createCalls: CreateSandboxOptions[] = [];
    const sandbox = createFakeSandbox("sbx_terminal");

    const terminalService = makeTerminalService({
      sandboxService: {
        createSandbox: (options) => {
          createCalls.push(options ?? {});
          return Effect.succeed(sandbox);
        },
        getSandbox: () => Effect.succeed(sandbox),
        deleteSandbox: () => Effect.void,
        startSandbox: () => Effect.succeed(sandbox),
        stopSandbox: () => Effect.succeed(sandbox),
        checkSandboxHealth: () =>
          Effect.succeed({
            sandbox,
            sandboxId: sandbox.id,
            lifecycleStatus: "ready",
            healthStatus: "healthy",
            daytonaState: "started",
            message: null,
            checkedAt: Date.now(),
          }),
      },
    });

    const session = await Effect.runPromise(
      terminalService.startPlaygroundSession({
        cwd: "/workspace",
      }),
    );

    expect(session.sandboxId).toBe("sbx_terminal");
    expect(createCalls).toEqual([
      {
        sandboxName: expect.stringMatching(/^jevin-playground-/),
        labels: {
          capability: "terminal",
        },
      },
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import { Sandbox } from "@daytonaio/sdk";
import * as Effect from "effect/Effect";

import type { CreateSandboxOptions } from "../sandbox";
import { makeGitService } from "./git.layer";

function createFakeSandbox(id: string): Sandbox {
  const sandbox = Object.create(Sandbox.prototype);
  sandbox.id = id;
  sandbox.git = {
    clone: async () => undefined,
  };
  sandbox.process = {
    executeCommand: async () => ({
      exitCode: 0,
      result: "# branch.oid 57c02d18\n# branch.head main\n",
    }),
  };
  sandbox.getWorkDir = async () => "/workspace";
  return sandbox;
}

describe("makeGitService", () => {
  test("delegates sandbox creation and cleanup to SandboxService", async () => {
    const createCalls: CreateSandboxOptions[] = [];
    const deleteCalls: string[] = [];
    const sandbox = createFakeSandbox("sbx_git");

    const gitService = makeGitService({
      sandboxService: {
        createSandbox: (options) => {
          createCalls.push(options ?? {});
          return Effect.succeed(sandbox);
        },
        getSandbox: () => Effect.succeed(sandbox),
        deleteSandbox: (target) => {
          deleteCalls.push(typeof target === "string" ? target : target.id);
          return Effect.void;
        },
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
      gitService.cloneRepository({
        url: "https://github.com/openai/jevin.git",
      }),
    );

    expect(createCalls).toEqual([
      {
        sandboxName: expect.stringMatching(/^jevin-git-/),
        labels: {
          capability: "git",
        },
      },
    ]);

    await Effect.runPromise(session.cleanup);
    expect(deleteCalls).toEqual(["sbx_git"]);
  });
});

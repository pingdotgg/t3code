import { createReplayJsonRpcProcessController } from "@t3tools/rr-e2e";

import type {
  CodexAppServerProcessController,
  CodexCliVersionCheckResult,
} from "../../../src/codexAppServerManager.ts";

import type { ReplayFixture } from "../types.ts";

export function makeReplayCodexProcessController(
  fixture: ReplayFixture,
  state: Record<string, unknown>,
): CodexAppServerProcessController {
  const controller = createReplayJsonRpcProcessController(fixture, state, {
    requestService: "codex.request",
    versionCheckService: "codex.versionCheck",
    requestContext: (input, request) => ({
      binaryPath: input.binaryPath,
      cwd: input.cwd,
      method: request.method,
      ...(request.params !== undefined ? { params: request.params } : {}),
    }),
  });

  return {
    spawnAppServer: controller.spawnAppServer,
    runVersionCheck: (input) => controller.runVersionCheck(input) as CodexCliVersionCheckResult,
    kill: (child) =>
      controller.kill(child as unknown as import("@t3tools/rr-e2e").ReplayJsonRpcChildProcess),
  };
}

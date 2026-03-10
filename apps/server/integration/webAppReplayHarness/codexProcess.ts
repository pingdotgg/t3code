import type { CodexAppServerProcessController } from "../../src/codexAppServerManager.ts";

import { createReplayJsonRpcProcessController } from "./jsonRpcProcessReplay.ts";
import type { ReplayFixture } from "./types.ts";

export function makeReplayCodexProcessController(
  fixture: ReplayFixture,
  state: Record<string, unknown>,
): CodexAppServerProcessController {
  return createReplayJsonRpcProcessController(fixture, state, {
    requestService: "codex.request",
    versionCheckService: "codex.versionCheck",
    requestContext: (input, request) => ({
      binaryPath: input.binaryPath,
      cwd: input.cwd,
      method: request.method,
      ...(request.params !== undefined ? { params: request.params } : {}),
    }),
  });
}

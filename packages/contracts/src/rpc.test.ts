import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import { ServerConfigSettingsUpdatedPayload } from "./server.ts";
import { DEFAULT_SERVER_SETTINGS } from "./settings.ts";

const encodeSettingsUpdatedPayload = Schema.encodeSync(ServerConfigSettingsUpdatedPayload);

describe("WebSocket RPC contracts", () => {
  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });

  it("sends compactIdleThreads as the boolean older clients decode", () => {
    const settings = { ...DEFAULT_SERVER_SETTINGS, compactIdleThreads: "off" as const };
    const successSchemas = [WS_METHODS.serverGetSettings, WS_METHODS.serverUpdateSettings].map(
      (method) => {
        const rpc = WsRpcGroup.requests.get(method);
        if (rpc === undefined) throw new Error(`${method} is not registered`);
        return rpc.successSchema;
      },
    );
    const encoded = [
      ...successSchemas.map((schema) => Schema.encodeUnknownSync(schema)(settings)),
      encodeSettingsUpdatedPayload({ settings }).settings,
    ];
    for (const value of encoded) {
      expect(value).toMatchObject({ compactIdleThreads: false, idleCompactionMode: "off" });
    }
  });
});

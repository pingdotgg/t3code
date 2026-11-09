import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as RpcSchema from "effect/rpc/RpcSchema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const pluginStates = WsRpcGroup.requests.get(WS_METHODS.pluginsSubscribeStates)?.successSchema;
if (pluginStates === undefined || !RpcSchema.isStreamSchema(pluginStates)) {
  throw new Error("plugins.subscribeStates is not a registered stream");
}
const decodePluginStates = Schema.decodeSync(pluginStates.success);

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

  it("keeps the plugin rows it knows when a newer server sends a status it doesn't", () => {
    const subscribeStates = WsRpcGroup.requests.get(WS_METHODS.pluginsSubscribeStates);
    if (subscribeStates === undefined) throw new Error("plugins.subscribeStates is not registered");
    const stream = subscribeStates.successSchema;
    if (!RpcSchema.isStreamSchema(stream))
      throw new Error("plugins.subscribeStates is not a stream");
    const row = {
      id: "known",
      name: "Known",
      permissions: [],
      source: "installed",
      enabled: true,
      status: "active",
      hasServer: false,
      hasWeb: true,
      hasSettings: false,
    };
    const decoded = decodePluginStates({
      plugins: [row, { ...row, id: "newer", status: "hibernating" }],
    });

    expect(decoded).toEqual({ plugins: [row] });
  });
});

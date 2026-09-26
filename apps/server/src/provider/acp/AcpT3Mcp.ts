import { type SelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as EffectAcpErrors from "effect-acp/errors";

import { makeAcpMcpOverAcpBridge } from "../../mcp/AcpMcpOverAcpBridge.ts";
import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type T3McpSession = Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">;

/**
 * T3's MCP server as ACP session setup entries. Stdio is ACP's baseline MCP
 * transport, and agents that advertise http still drop injected http servers,
 * so every agent gets the `t3 acp-mcp-bridge` stdio server. It forwards to
 * T3's authenticated MCP endpoint, and the credential stays in its
 * environment, never on the command line. The runtime sends the `acp` server
 * instead when the agent advertises MCP-over-ACP; see `serveAcpMcpOverAcp`.
 */
export function acpT3McpServers(
  session: T3McpSession,
  self: SelfInvocation,
): Pick<AcpSessionRuntime.AcpSessionRuntimeOptions, "mcpServers" | "acpMcpServers"> {
  return {
    mcpServers: [
      {
        name: "t3-code",
        command: self.command,
        args: [...selfInvocationArgs(self, ["acp-mcp-bridge"])],
        env: [
          { name: "ELECTRON_RUN_AS_NODE", value: "1" },
          { name: "T3_ACP_MCP_ENDPOINT", value: session.endpoint },
          { name: "T3_ACP_MCP_AUTHORIZATION", value: session.authorizationHeader },
        ],
      },
    ],
    acpMcpServers: [{ type: "acp", name: "t3-code", serverId: "t3-code" }],
  };
}

/**
 * Answers the runtime's MCP-over-ACP requests through T3's MCP endpoint.
 * Register before `start()`; the connections close with the scope.
 */
export const serveAcpMcpOverAcp = Effect.fn("serveAcpMcpOverAcp")(function* (
  runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "handleMcpConnect" | "handleMcpMessage" | "handleMcpNotification" | "handleMcpDisconnect"
  >,
  session: T3McpSession,
) {
  const crypto = yield* Crypto.Crypto;
  const bridge = yield* makeAcpMcpOverAcpBridge({
    endpoint: session.endpoint,
    authorization: session.authorizationHeader,
    allocateConnectionId: crypto.randomUUIDv4.pipe(Effect.orDie),
  });
  yield* Scope.addFinalizer(yield* Effect.scope, bridge.dispose);
  const mapBridgeError = Effect.mapError(
    (error: Error) =>
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: error.message,
        cause: error,
      }),
  );
  yield* runtime.handleMcpConnect((request) => bridge.connect(request).pipe(mapBridgeError));
  yield* runtime.handleMcpMessage((request) => bridge.message(request).pipe(mapBridgeError));
  yield* runtime.handleMcpNotification((request) =>
    bridge.notification(request).pipe(mapBridgeError),
  );
  yield* runtime.handleMcpDisconnect((request) => bridge.disconnect(request).pipe(mapBridgeError));
});

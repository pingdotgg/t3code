import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  DAEMON_RPCS,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { RpcClient, RpcGroup, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

const DaemonRpcGroup = RpcGroup.make(...DAEMON_RPCS);
const makeDaemonRpcClient = RpcClient.make(DaemonRpcGroup);
export type DaemonRpcClient = Effect.Success<typeof makeDaemonRpcClient>;

/** Daemons have no MCP tools, so the CLI speaks the clients' /ws RPC protocol. */
export const daemonRpcSession = Effect.fn("cli.daemon.rpcSession")(function* (input: {
  readonly origin: string;
  readonly token: string;
}) {
  const url = new URL("/ws", input.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION_TEXT);
  const protocol = yield* Layer.build(
    Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Socket.layerWebSocket(url.href, {
          openTimeout: "15 seconds",
          headers: { authorization: `Bearer ${input.token}` },
        }),
      ),
      Layer.provide(NodeSocket.layerWebSocketConstructor),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  return yield* makeDaemonRpcClient.pipe(Effect.provide(protocol));
});

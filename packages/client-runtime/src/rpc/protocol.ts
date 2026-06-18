import { WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/unstable/rpc";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

import * as RpcGroup from "effect/rpc/RpcGroup";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";
import { WsRpcGroup } from "@t3tools/contracts";

export const ServerWsRpcGroup = WsRpcGroup.middleware(RpcInstrumentation);

// RpcGroup.toLayer derives each handler's requirements by scanning every RPC in
// the group, so its type cost grows with handlers × RPCs. Near 200 methods that
// crosses TypeScript's instantiation limit and the layer's requirements degrade to
// `any`, so the handlers are registered as two disjoint, smaller groups.
export type ServerWsRpc = RpcGroup.Rpcs<typeof ServerWsRpcGroup>;
const SPLIT_WS_RPC_PREFIXES = ["server", "pullRequests", "provider", "orchestration"] as const;
export type SplitWsRpc = Extract<
  ServerWsRpc,
  { readonly _tag: `${(typeof SPLIT_WS_RPC_PREFIXES)[number]}.${string}` }
>;
const isSplitWsRpc = (rpc: ServerWsRpc): rpc is SplitWsRpc =>
  SPLIT_WS_RPC_PREFIXES.some((prefix) => rpc._tag.startsWith(`${prefix}.`));
const isOtherWsRpc = (rpc: ServerWsRpc): rpc is Exclude<ServerWsRpc, SplitWsRpc> =>
  !isSplitWsRpc(rpc);
const serverWsRpcs = Array.from(ServerWsRpcGroup.requests.values());
const SplitWsRpcGroup = RpcGroup.make(...serverWsRpcs.filter(isSplitWsRpc));
const OtherWsRpcGroup = RpcGroup.make(...serverWsRpcs.filter(isOtherWsRpc));

export { OtherWsRpcGroup, SplitWsRpcGroup };
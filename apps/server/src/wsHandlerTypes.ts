import type * as RpcGroup from "effect/rpc/RpcGroup";

import type { ServerWsRpcGroup } from "./wsRpcGroups.ts";
import type { WsHandlerClosures } from "./wsHandlerClosures.ts";
import type { WsHandlerServices } from "./wsHandlerServices.ts";

/** Everything a WS RPC handler module may close over. */
export type WsHandlerContext = WsHandlerServices & WsHandlerClosures;

export type AllWsHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ServerWsRpcGroup>>;

/**
 * The `Website.Server` provider group served by the dev sidecar (see
 * `Local/Sidecar.ts`), so a framework dev server outlives exec-child reloads.
 */
import type * as RpcServer from "../Local/RpcServer.ts";
import { ServerProviderLocal } from "./Server.ts";

export default ServerProviderLocal() satisfies RpcServer.ProviderLayer;

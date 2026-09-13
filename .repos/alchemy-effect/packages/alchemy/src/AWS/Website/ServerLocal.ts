import * as RpcServer from "../../Local/RpcServer.ts";
import { ServerProviderLocal } from "../../Website/Server.ts";

ServerProviderLocal().pipe(RpcServer.launch);

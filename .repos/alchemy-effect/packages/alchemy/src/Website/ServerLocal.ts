import * as RpcServer from "../Local/RpcServer.ts";
import { ServerProviderLocal } from "./Server.ts";

ServerProviderLocal().pipe(RpcServer.launch);

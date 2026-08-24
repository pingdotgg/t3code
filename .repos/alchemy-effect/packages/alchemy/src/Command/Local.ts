import * as Layer from "effect/Layer";
import * as RpcServer from "../Local/RpcServer.ts";
import { CommandExecutorLive } from "./Command.ts";
import { DevProviderLocal } from "./Dev.ts";

DevProviderLocal().pipe(Layer.provide(CommandExecutorLive()), RpcServer.launch);

/**
 * The `Command.Dev` provider group served by the dev sidecar (see
 * `Local/Sidecar.ts`), so a dev server process outlives exec-child reloads.
 */
import * as Layer from "effect/Layer";
import type * as RpcServer from "../Local/RpcServer.ts";
import { CommandExecutorLive } from "./Command.ts";
import { DevProviderLocal } from "./Dev.ts";

export default DevProviderLocal().pipe(
  Layer.provide(CommandExecutorLive()),
) satisfies RpcServer.ProviderLayer;

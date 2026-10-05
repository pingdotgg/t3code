import * as Cloudflare from "@/Cloudflare";
import type { Named, PlatformIdentity } from "@/index.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcServer from "effect/rpc/RpcServer";

const ping = Rpc.make("ping", {
  success: Schema.Void,
  payload: {},
});

class PingRpcs extends RpcGroup.make(ping) {}

class ModularRpcWorker extends Cloudflare.RpcWorker<ModularRpcWorker>()(
  "ModularRpcWorker",
  { schema: PingRpcs },
) {}

class InlineRpcWorker extends Cloudflare.RpcWorker<InlineRpcWorker>()(
  "InlineRpcWorker",
  { main: import.meta.url, schema: PingRpcs },
  Effect.succeed(RpcServer.toHttpEffect(PingRpcs)),
) {}

class OrdinaryWorker extends Cloudflare.Worker<OrdinaryWorker>()(
  "OrdinaryWorker",
  {},
) {}

const identity = <const Id extends string>(
  declaration: PlatformIdentity<Id>,
): Id => declaration.LogicalId;

export const _ordinaryIdentity: "OrdinaryWorker" = identity(OrdinaryWorker);
export const _modularIdentity: "ModularRpcWorker" = identity(ModularRpcWorker);
export const _inlineIdentity: "InlineRpcWorker" = identity(InlineRpcWorker);

// @ts-expect-error RpcWorker identity is readonly.
ModularRpcWorker.LogicalId = "ModularRpcWorker";

type Assert<T extends true> = T;
type _PhantomInstances = Assert<
  "LogicalId" extends keyof ModularRpcWorker | keyof InlineRpcWorker
    ? false
    : true
>;

type _ModularNamed = Assert<
  ModularRpcWorker extends Named<"ModularRpcWorker"> ? true : false
>;
type _ModularLogicalId = Assert<
  typeof ModularRpcWorker extends { readonly LogicalId: "ModularRpcWorker" }
    ? true
    : false
>;
type _InlineNamed = Assert<
  InlineRpcWorker extends Named<"InlineRpcWorker"> ? true : false
>;
type _InlineLogicalId = Assert<
  typeof InlineRpcWorker extends { readonly LogicalId: "InlineRpcWorker" }
    ? true
    : false
>;
// Widening to `string` would still satisfy Named<string>; pin the literal.
type _ModularIdIsNotWidened = Assert<
  ModularRpcWorker extends Named<"other"> ? false : true
>;

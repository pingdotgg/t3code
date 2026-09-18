import * as Cloudflare from "@/Cloudflare";
import type { Named } from "@/Named";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

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

type Assert<T extends true> = T;

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

import * as Cloudflare from "@/Cloudflare";
import { normalizeTransferredFrom } from "@/Cloudflare/Workers/DurableObject";
import { expect, test } from "alchemy-test";
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

test("RpcWorker modular class copies LogicalId from the underlying Worker", () => {
  expect(ModularRpcWorker.LogicalId).toBe("ModularRpcWorker");
});

test("RpcWorker inline class copies LogicalId from the underlying Worker", () => {
  expect(InlineRpcWorker.LogicalId).toBe("InlineRpcWorker");
});

test("RpcWorker class is a transferredFrom source by logical id", () => {
  expect(normalizeTransferredFrom(ModularRpcWorker)).toEqual([
    "ModularRpcWorker",
  ]);
  expect(normalizeTransferredFrom(InlineRpcWorker)).toEqual([
    "InlineRpcWorker",
  ]);
});

import * as Cloudflare from "@alchemy.run/cloudflare";
import { normalizeTransferredFrom } from "@alchemy.run/cloudflare/Workers/DurableObject";
import { expect, test } from "@alchemy.run/test";
import type { PlatformIdentity } from "alchemy/Platform";
import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Schema from "effect/Schema";

const ping = Rpc.make("ping", { success: Schema.Void, payload: {} });

class PingRpcs extends RpcGroup.make(ping) {}

class ModularRpcWorker extends Cloudflare.RpcWorker<ModularRpcWorker>()("ModularRpcWorker", {
  schema: PingRpcs,
}) {}

class InlineRpcWorker extends Cloudflare.RpcWorker<InlineRpcWorker>()(
  "InlineRpcWorker",
  { main: import.meta.url, schema: PingRpcs },
  Effect.succeed(RpcServer.toHttpEffect(PingRpcs)),
) {}

const identity = <const Id extends string>(declaration: PlatformIdentity<Id>): Id =>
  declaration.LogicalId;

class OrdinaryWorker extends Cloudflare.Worker<OrdinaryWorker>()("OrdinaryWorker", {}) {}

test(
  "ordinary and RPC Workers share a native identity reader",
  () => {
    expect(identity(OrdinaryWorker)).toBe("OrdinaryWorker");
    expect(identity(ModularRpcWorker)).toBe("ModularRpcWorker");
    expect(identity(InlineRpcWorker)).toBe("InlineRpcWorker");
  },
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
);

test(
  "RpcWorker modular class copies LogicalId from the underlying Worker",
  () => {
    expect(ModularRpcWorker.LogicalId).toBe("ModularRpcWorker");
  },
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
);

test(
  "RpcWorker inline class copies LogicalId from the underlying Worker",
  () => {
    expect(InlineRpcWorker.LogicalId).toBe("InlineRpcWorker");
  },
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
);

test(
  "RpcWorker class is a transferredFrom source by logical id",
  () => {
    expect(normalizeTransferredFrom(ModularRpcWorker)).toEqual(["ModularRpcWorker"]);
    expect(normalizeTransferredFrom(InlineRpcWorker)).toEqual(["InlineRpcWorker"]);
  },
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
);

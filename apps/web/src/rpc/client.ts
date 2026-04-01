import { WsRpcGroup } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { AtomRpc } from "effect/unstable/reactivity";

import { createWsRpcProtocolLayer } from "./protocol";

export class WsRpcAtomClient extends AtomRpc.Service<WsRpcAtomClient>()("WsRpcAtomClient", {
  group: WsRpcGroup,
  protocol: Layer.suspend(() => createWsRpcProtocolLayer()),
}) {}

let sharedRuntime: ManagedRuntime.ManagedRuntime<WsRpcAtomClient, never> | null = null;

function getRuntime() {
  if (sharedRuntime !== null) {
    return sharedRuntime;
  }

  sharedRuntime = ManagedRuntime.make(WsRpcAtomClient.layer);
  return sharedRuntime;
}

export function runRpc<TSuccess, TError = never>(
  execute: (client: typeof WsRpcAtomClient.Service) => Effect.Effect<TSuccess, TError, never>,
): Promise<TSuccess> {
  return getRuntime().runPromise(WsRpcAtomClient.use(execute));
}

export async function __resetWsRpcAtomClientForTests() {
  const runtime = sharedRuntime;
  sharedRuntime = null;
  await runtime?.dispose();
}

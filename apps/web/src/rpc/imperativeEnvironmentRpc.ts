// [FORK] Imperative (Promise-returning) bridge over the new Effect/atom RPC
// architecture introduced by upstream #2978. The fork's PR-review feature and
// `localApi.server.*` consumers are written against imperative Promise APIs
// (`environmentApi.git.*`, `localApi.server.*`). The upstream rewrite removed
// the old `WsRpcClient` in favor of atoms, so we re-expose a thin imperative
// shim that runs a single unary RPC against a specific environment and resolves
// to a Promise, reusing the same runtime + registry the atoms use.
import type { EnvironmentId } from "@t3tools/contracts";
import {
  request,
  type EnvironmentRpcInput,
  type EnvironmentRpcSuccess,
  type EnvironmentUnaryRpcTag,
} from "@t3tools/client-runtime/rpc";
import { executeAtomQuery, runInEnvironment } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { appAtomRegistry } from "./atomRegistry";

/**
 * Invoke a unary environment RPC imperatively and resolve to its result, or
 * reject with the underlying failure/defect (mirroring the old client's
 * Promise rejection semantics).
 */
export async function callEnvironmentRpc<TTag extends EnvironmentUnaryRpcTag>(
  environmentId: EnvironmentId,
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Promise<EnvironmentRpcSuccess<TTag>> {
  const atom = connectionAtomRuntime
    .atom(runInEnvironment(environmentId, request(tag, input)))
    .pipe(Atom.withLabel(`imperative-rpc:${tag}`));
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    reportFailure: false,
    reportDefect: false,
  });
  if (result._tag === "Success") {
    return result.value;
  }
  throw Cause.squash(result.cause);
}

/** Read the currently-paired primary environment id, or `null` when unpaired. */
export function readPrimaryEnvironmentId(): EnvironmentId | null {
  return appAtomRegistry.get(primaryEnvironmentIdAtom);
}

/**
 * Invoke a unary RPC against the primary (paired local) environment. Rejects
 * with the legacy "unavailable backend" error when no primary environment is
 * paired yet, matching the previous `localApi.server.*` behaviour.
 */
export async function callPrimaryRpc<TTag extends EnvironmentUnaryRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Promise<EnvironmentRpcSuccess<TTag>> {
  const environmentId = readPrimaryEnvironmentId();
  if (!environmentId) {
    throw new Error("Local backend API is unavailable before a backend is paired.");
  }
  return callEnvironmentRpc(environmentId, tag, input);
}

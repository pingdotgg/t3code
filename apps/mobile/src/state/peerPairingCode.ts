import * as Effect from "effect/Effect";
import {
  observeAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { createPeerPairingCodeCommand } from "@t3tools/client-runtime/state/peerPairingCode";

import type { AuthMcpClientAccess, EnvironmentId } from "@t3tools/contracts";
import * as Result from "effect/Result";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

const mintPairingCode = createPeerPairingCodeCommand(connectionAtomRuntime);

/**
 * A fresh pairing code minted on `environmentId` with this client's session
 * there, for linking with `access`. Fails with `PeerPairingCodeError` when the
 * session may not create one.
 */
export async function mintPairingCodeOn(
  environmentId: EnvironmentId,
  access: AuthMcpClientAccess,
): Promise<Result.Result<string, unknown>> {
  const result = await Effect.runPromise(
    observeAtomCommand(appAtomRegistry, mintPairingCode, {
      environmentId,
      input: access,
    }),
  );
  return result._tag === "Success"
    ? Result.succeed(result.value)
    : Result.fail(squashAtomCommandFailure(result));
}

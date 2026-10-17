import { createPeerPairingCodeCommand } from "@t3tools/client-runtime/state/peerPairingCode";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Result from "effect/Result";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const mintPairingCode = createPeerPairingCodeCommand(connectionAtomRuntime);

/**
 * A fresh pairing code minted on `environmentId` with this client's session
 * there, for answering a link request. Fails with `PeerPairingCodeError` when
 * the session may not create one.
 */
export async function mintPairingCodeOn(
  environmentId: EnvironmentId,
): Promise<Result.Result<string, unknown>> {
  const result = await mintPairingCode.run(appAtomRegistry, { environmentId, input: undefined });
  return result._tag === "Success"
    ? Result.succeed(result.value)
    : Result.fail(squashAtomCommandFailure(result));
}

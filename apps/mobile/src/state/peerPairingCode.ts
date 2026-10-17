import { createPeerPairingCodeCommand } from "@t3tools/client-runtime/state/peerPairingCode";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

const mintPairingCode = createPeerPairingCodeCommand(connectionAtomRuntime);

/**
 * A fresh pairing code minted on `environmentId` with this client's session
 * there, for answering a link request. Rejects with `PeerPairingCodeError`
 * when the session may not create one.
 */
export async function mintPairingCodeOn(environmentId: EnvironmentId): Promise<string> {
  const result = await mintPairingCode.run(appAtomRegistry, { environmentId, input: undefined });
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

import {
  createMcpApprovalCodeCommand,
  createPeerPairingCodeMinter,
} from "@t3tools/client-runtime/state/peerPairingCode";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AuthMcpClientAccess,
  AuthPairingCredentialResult,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const mintPairingCodeOn = createPeerPairingCodeMinter(
  connectionAtomRuntime,
  appAtomRegistry,
);

const mintMcpApprovalCode = createMcpApprovalCodeCommand(connectionAtomRuntime);

/** A fresh code on `environmentId` that approves one app's sign-in at `access`. */
export async function mintMcpApprovalCodeOn(
  environmentId: EnvironmentId,
  access: AuthMcpClientAccess,
): Promise<Result.Result<AuthPairingCredentialResult, unknown>> {
  const result = await mintMcpApprovalCode.run(appAtomRegistry, { environmentId, input: access });
  return result._tag === "Success"
    ? Result.succeed(result.value)
    : Result.fail(squashAtomCommandFailure(result));
}

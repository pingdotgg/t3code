import {
  createConnectMcpApprovalCodeCommand,
  createMcpApprovalCodeCommand,
  createPeerPairingCodeCommand,
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

const mintPairingCode = createPeerPairingCodeCommand(connectionAtomRuntime);
const mintMcpApprovalCode = createMcpApprovalCodeCommand(connectionAtomRuntime);
const connectMcpApprovalCodeCommand = createConnectMcpApprovalCodeCommand(connectionAtomRuntime);

/**
 * A fresh pairing code minted on `environmentId` with this client's session
 * there, for linking with `access`. Fails with `PeerPairingCodeError` when the
 * session may not create one.
 */
export async function mintPairingCodeOn(
  environmentId: EnvironmentId,
  access: AuthMcpClientAccess,
): Promise<Result.Result<string, unknown>> {
  const result = await mintPairingCode.run(appAtomRegistry, { environmentId, input: access });
  return result._tag === "Success"
    ? Result.succeed(result.value)
    : Result.fail(squashAtomCommandFailure(result));
}

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

/**
 * A fresh app approval code on an environment this T3 Connect account owns, for the sign-in
 * page at `pageOrigin`; fails with `ConnectApprovalCodeError` when that is not its relay address.
 */
export async function mintConnectMcpApprovalCode(input: {
  readonly environmentId: EnvironmentId;
  readonly pageOrigin: string;
  readonly access: AuthMcpClientAccess;
}): Promise<Result.Result<string, unknown>> {
  const result = await connectMcpApprovalCodeCommand.run(appAtomRegistry, input);
  return result._tag === "Success"
    ? Result.succeed(result.value)
    : Result.fail(squashAtomCommandFailure(result));
}

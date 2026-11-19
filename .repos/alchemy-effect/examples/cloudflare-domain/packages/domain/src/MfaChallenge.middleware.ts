import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

/** The request lacks a valid second factor. */
export class MfaRequired extends Schema.TaggedError<MfaRequired>()("MfaRequired", {}) {}

/** Requires a second factor for sensitive operations. */
export class MfaChallenge extends RpcMiddleware.Service<MfaChallenge>()("Bank/MfaChallenge", {
  error: MfaRequired,
}) {}

import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import { CurrentUser } from "./CurrentUser.context.ts";

/** The request has no session. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

/** Provides the signed-in user, from the session cookie better-auth set. */
export class Session extends RpcMiddleware.Service<Session, { provides: CurrentUser }>()(
  "Notes/Session",
  { error: Unauthorized },
) {}

import * as Headers from "effect/http/Headers";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import { CurrentActor } from "./CurrentActor.context.ts";

/** The request has no session. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

/** The cookie that carries a customer's session in a browser. */
export const SESSION_COOKIE = "bank_session";

/**
 * Authenticates a request, from a customer or a support agent, and provides
 * who is making it as the {@link CurrentActor}. Authorization is up to each
 * command's `decide` and each view's `validate`.
 *
 * Browsers authenticate with the session cookie, which also reaches live
 * reads: a WebSocket upgrade carries cookies, never a header a client sets.
 * Other clients (tests, support tooling) send `Authorization` instead.
 */
export class Session extends RpcMiddleware.Service<Session, { provides: CurrentActor }>()(
  "Bank/Session",
  { error: Unauthorized },
) {}

/** Client side, for clients that are not browsers: send this token with every call. */
export const sessionClient = (token: string) =>
  RpcMiddleware.layerClient(Session, ({ request, next }) =>
    next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) }),
  );

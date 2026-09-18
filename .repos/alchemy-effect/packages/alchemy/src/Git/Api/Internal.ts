/**
 * The engine's internal API: routes the engine calls on itself, never a
 * user. Register `Git.InternalApiLive` beside public routes, outside user middleware.
 */
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { HASH_ROUTE } from "../Hasher/Protocol.ts";

/**
 * The push pipeline's hashing endpoint (DESIGN §22.7), reached through the
 * Worker's self service binding by the fan-out {@link Hasher} and
 * authenticated with the deploy-time internal secret, never a user
 * credential.
 */
export const HashPart = HttpApiEndpoint.post("hashPart", HASH_ROUTE);

/** The internal group, mounted at the root. */
export class Internal extends HttpApiGroup.make("internal", {
  topLevel: true,
}).add(HashPart) {}

/**
 * The internal API schema. `Git.InternalApiLive` registers its routes using
 * `HttpApiBuilder.layer(Git.InternalApi)` with `Git.InternalLive`.
 */
export class InternalApi extends HttpApi.make("git-internal").add(Internal) {}

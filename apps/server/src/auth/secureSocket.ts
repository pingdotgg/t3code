import { makeSecureEnvironmentSocket } from "@t3tools/shared/secureChannelSocket";
import * as Effect from "effect/Effect";
import type { HttpServerRequest } from "effect/http";

import { EnvironmentSigningKey } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { AuthenticatedSession } from "./EnvironmentAuth.ts";

/**
 * Upgrades a media route's socket. When the verified upgrade proof asked for the secure channel,
 * the socket runs the handshake first and never carries a plaintext frame; what the route
 * forwards onward on this host stays as it is.
 */
export const upgradeMediaSocket = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  session: Pick<AuthenticatedSession, "secureChannel" | "proofKeyThumbprint">,
) {
  if (session.secureChannel !== true || session.proofKeyThumbprint === undefined) {
    return yield* request.upgrade;
  }
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const identity = yield* (yield* EnvironmentSigningKey).secureChannelIdentity.pipe(Effect.orDie);
  return yield* makeSecureEnvironmentSocket(yield* request.upgrade, {
    context: new TextEncoder().encode(environmentId),
    identity,
    proofKeyThumbprint: session.proofKeyThumbprint,
  });
});

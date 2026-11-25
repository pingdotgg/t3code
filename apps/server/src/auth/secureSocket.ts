import {
  makeSecureEnvironmentSocket,
  mediaSocketContext,
} from "@t3tools/shared/secureChannelSocket";
import * as Effect from "effect/Effect";
import type { HttpServerRequest } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { EnvironmentSigningKey } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { AuthenticatedSession } from "./EnvironmentAuth.ts";

/**
 * Upgrades a media route's socket. When the verified upgrade proof asked for the secure channel,
 * the socket never carries a plaintext frame; what the route forwards onward on this host stays
 * as it is. The handshake has finished when this returns: only it authenticates the query, so a
 * route must not act on the query before it (see `mediaSocketContext`).
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
  const socket = yield* makeSecureEnvironmentSocket(yield* request.upgrade, {
    context: mediaSocketContext(
      environmentId,
      new URL(request.originalUrl, "http://localhost").searchParams,
    ),
    identity,
    proofKeyThumbprint: session.proofKeyThumbprint,
  });
  const reader = yield* socket.reader;
  return Socket.make({ reader: Effect.succeed(reader), writer: socket.writer });
});

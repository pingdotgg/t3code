import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { readPreparedConnection, usePreparedConnection } from "../../state/session";

export function literalLoopback(url: URL) {
  return url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
}

export function privateVaultRoute(
  environmentId: EnvironmentId,
  connection = readPreparedConnection(environmentId),
) {
  if (
    connection?.environmentId !== environmentId ||
    connection.descriptor?.environmentId !== environmentId
  )
    return null;
  const origin = URL.parse(connection.httpBaseUrl);
  const socket = URL.parse(connection.socketUrl);
  if (
    !origin ||
    !socket ||
    origin.username ||
    origin.password ||
    socket.username ||
    socket.password ||
    !(origin.protocol === "https:" || (origin.protocol === "http:" && literalLoopback(origin))) ||
    !(socket.protocol === "wss:" || (socket.protocol === "ws:" && literalLoopback(socket)))
  )
    return null;
  const direct =
    connection.target._tag === "PrimaryConnectionTarget" ||
    connection.target._tag === "BearerConnectionTarget";
  return { origin, direct };
}

export function usePrivateVaultRoute(environmentId: EnvironmentId) {
  const connection = usePreparedConnection(environmentId);
  return privateVaultRoute(environmentId, Option.getOrNull(connection));
}

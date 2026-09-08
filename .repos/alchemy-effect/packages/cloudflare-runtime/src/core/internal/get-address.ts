import * as Effect from "effect/Effect";
import type * as NodeHttp from "node:http";
import { SystemError } from "../RuntimeError.shared.ts";

/**
 * Addresses that mean "listen on every interface". They are valid *bind*
 * addresses but must never be used as a *connect* target: on Linux/macOS
 * connecting to `0.0.0.0` is quietly treated as "this host", but on Windows
 * `ConnectEx` fails with `ERROR_DUP_NAME` (#52, "a duplicate name exists on
 * the network"). workerd consumes the addresses we produce here as external
 * service connect targets, so we always normalize unspecified addresses to
 * `127.0.0.1` (matching miniflare's behavior).
 */
const UNSPECIFIED_ADDRESSES: ReadonlySet<string> = new Set([
  "0.0.0.0",
  "::",
  "::0",
  "0000:0000:0000:0000:0000:0000:0000:0000",
]);

/** Maps listen-all/unspecified hosts to a loopback host that is safe to connect to on every platform. */
export const toConnectableHost = (host: string): string =>
  UNSPECIFIED_ADDRESSES.has(host) ? "127.0.0.1" : host;

export const getAddress = (
  server: NodeHttp.Server,
): Effect.Effect<string, SystemError> => {
  const address = server.address();
  if (address === null) {
    return Effect.fail(
      new SystemError({
        subtag: "ServerAddressNotAvailable",
        message: "Server address is not available.",
        detail: { server },
      }),
    );
  }
  if (typeof address === "string") {
    return Effect.succeed(address);
  }
  return Effect.succeed(
    `${toConnectableHost(address.address)}:${address.port}`,
  );
};

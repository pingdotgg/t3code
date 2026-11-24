import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SocketServer from "effect/socket/SocketServer";

export class LoopbackTunnelPortInUseError extends Schema.TaggedError<
  LoopbackTunnelPortInUseError,
  { readonly brand: unique symbol }
>()("LoopbackTunnelPortInUseError", { port: Schema.Number }) {
  override get message(): string {
    return `Local port ${this.port} is already in use.`;
  }
}

/** The original URL must work as written, including for names that resolve to IPv6 first. */
export function bindPinnedPort(
  port: number,
  ipv6Busy: boolean,
  bind: (
    port: number,
  ) => Effect.Effect<SocketServer.SocketServer["Service"], SocketServer.SocketServerError>,
): Effect.Effect<
  SocketServer.SocketServer["Service"],
  SocketServer.SocketServerError | LoopbackTunnelPortInUseError
> {
  if (ipv6Busy) return Effect.fail(new LoopbackTunnelPortInUseError({ port }));
  return bind(port).pipe(
    Effect.mapError((error) => {
      const cause = error.reason.cause;
      return typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "EADDRINUSE"
        ? new LoopbackTunnelPortInUseError({ port })
        : error;
    }),
  );
}

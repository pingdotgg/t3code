import * as NodeTls from "node:tls";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";

const TLS_PROBE_TIMEOUT_MS = 1_000;

/**
 * Whether the loopback listener on `host:port` completes a TLS handshake. Sends only a
 * ClientHello and never validates the certificate: the answer is about the protocol, not
 * trust, so a locally issued certificate (mkcert) still counts.
 */
export const probeTlsListener = (input: {
  readonly host: string;
  readonly port: number;
}): Effect.Effect<boolean> => {
  if (!isLoopbackHost(input.host)) return Effect.succeed(false);
  const host = input.host === "0.0.0.0" ? "127.0.0.1" : input.host === "[::1]" ? "::1" : input.host;
  return Effect.callback<boolean>((resume) => {
    const socket = NodeTls.connect({
      host,
      port: input.port,
      rejectUnauthorized: false,
      // An IP literal is not a valid ServerName; a local certificate names localhost.
      servername: "localhost",
    });
    const finish = (tls: boolean) => {
      socket.destroy();
      resume(Effect.succeed(tls));
    };
    socket.once("secureConnect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(TLS_PROBE_TIMEOUT_MS, () => finish(false));
    return Effect.sync(() => socket.destroy());
  });
};

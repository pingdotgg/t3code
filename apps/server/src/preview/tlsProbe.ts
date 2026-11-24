import * as NodeTls from "node:tls";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const TLS_PROBE_TIMEOUT_MS = 1_000;

/**
 * Whether the loopback listener on `host:port` completes a TLS handshake. Sends only a
 * ClientHello and never validates the certificate: the answer is about the protocol, not
 * trust, so a locally issued certificate (mkcert) still counts.
 */
export const probeTlsListener = Effect.fn("probeTlsListener")((input: {
  readonly host: string;
  readonly port: number;
}): Effect.Effect<boolean> => {
  if (!isLoopbackHost(input.host)) return Effect.succeed(false);
  const host = input.host === "0.0.0.0" ? "127.0.0.1" : input.host === "[::1]" ? "::1" : input.host;
  const probe = Effect.callback<boolean>((resume) => {
    const socket = NodeTls.connect({
      host,
      port: input.port,
      rejectUnauthorized: false,
      // An IP literal is not a valid ServerName; a local certificate names localhost.
      servername: "localhost",
    });
    let done = false;
    const finish = (tls: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resume(Effect.succeed(tls));
    };
    socket.once("secureConnect", () => finish(true));
    socket.once("error", () => finish(false));
    return Effect.sync(() => {
      done = true;
      socket.destroy();
    });
  });
  // A total handshake deadline: socket.setTimeout measures inactivity, so a peer
  // dribbling handshake fragments could otherwise hold the scan past the limit.
  // Interrupting the probe destroys the socket through the callback cleanup.
  return probe.pipe(
    Effect.timeoutOption(Duration.millis(TLS_PROBE_TIMEOUT_MS)),
    Effect.map(Option.getOrElse(() => false)),
  );
});

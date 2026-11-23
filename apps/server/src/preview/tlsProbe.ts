import * as NodeTls from "node:tls";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/** How long an on-demand probe may wait for a handshake before answering "not TLS". */
const TLS_PROBE_TIMEOUT = Duration.millis(1_000);

/**
 * Whether the listener on `host:port` completes a TLS handshake. Sends only a TLS
 * ClientHello, never HTTP bytes, and never validates the certificate: the answer is
 * about the protocol, not trust, so a locally issued certificate (mkcert) still counts.
 * False for plain-HTTP listeners, closed ports, timeouts, and non-loopback hosts.
 */
export const probeTlsListener = (
  input: { readonly host: string; readonly port: number },
  timeout: Duration.DurationInput = TLS_PROBE_TIMEOUT,
): Effect.Effect<boolean> => {
  if (!isLoopbackHost(input.host)) return Effect.succeed(false);
  const host = input.host === "0.0.0.0" ? "127.0.0.1" : input.host;
  return Effect.promise(
    () =>
      new Promise<boolean>((resolve) => {
        const socket = NodeTls.connect({
          host,
          port: input.port,
          rejectUnauthorized: false,
          // The certificate, if any, names the loopback host; an IP literal is not
          // a valid ServerName.
          servername: "localhost",
        });
        let done = false;
        const finish = (result: boolean) => {
          if (done) return;
          done = true;
          socket.destroy();
          resolve(result);
        };
        socket.once("secureConnect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.setTimeout(Duration.toMillis(timeout), () => finish(false));
      }),
  );
};

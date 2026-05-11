import * as NodeNet from "node:net";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Predicate from "effect/Predicate";

export class NetError extends Data.TaggedError("NetError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const isErrnoExceptionWithCode = (
  cause: unknown,
): cause is {
  readonly code: string;
} =>
  Predicate.isObject(cause) &&
  Predicate.hasProperty(cause, "code") &&
  Predicate.isString(cause.code);

const closeServer = (server: NodeNet.Server) => {
  try {
    server.close();
  } catch {
    // Ignore close failures during cleanup.
  }
};

const tryReservePort = (port: number): Effect.Effect<number, NetError> =>
  Effect.callback<number, NetError>((resume) => {
    const server = NodeNet.createServer();
    let settled = false;

    const settle = (effect: Effect.Effect<number, NetError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };

    server.unref();

    server.once("error", (cause) => {
      settle(Effect.fail(new NetError({ message: "Could not find an available port.", cause })));
    });

    server.listen(port, () => {
      const address = server.address();
      const resolved = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (resolved > 0) {
          settle(Effect.succeed(resolved));
          return;
        }
        settle(Effect.fail(new NetError({ message: "Could not find an available port." })));
      });
    });

    return Effect.sync(() => {
      closeServer(server);
    });
  });

export interface NetServiceShape {
  /**
   * Returns true when a TCP server can bind to {host, port}.
   */
  readonly canListenOnHost: (port: number, host: string) => Effect.Effect<boolean>;

  /**
   * Checks loopback availability on both IPv4 and IPv6 localhost addresses.
   */
  readonly isPortAvailableOnLoopback: (port: number) => Effect.Effect<boolean>;

  /**
   * Reserve an ephemeral loopback port and release it immediately.
   */
  readonly reserveLoopbackPort: (host?: string) => Effect.Effect<number, NetError>;

  /**
   * Resolve an available listening port, preferring the provided port first.
   */
  readonly findAvailablePort: (preferred: number) => Effect.Effect<number, NetError>;
}

/**
 * NetService - Service tag for startup networking helpers.
 */
export class NetService extends Context.Service<NetService, NetServiceShape>()(
  "@t3tools/shared/Net/NetService",
) {}

export const make = () => {
  /**
   * Returns true when a TCP server can bind to {host, port}.
   * `EADDRNOTAVAIL` is treated as available so IPv6-absent hosts don't fail
   * loopback availability checks.
   */
  const canListenOnHost = (port: number, host: string): Effect.Effect<boolean> =>
    Effect.callback<boolean>((resume) => {
      const server = NodeNet.createServer();
      let settled = false;

      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed(value));
      };

      server.unref();

      server.once("error", (cause) => {
        if (isErrnoExceptionWithCode(cause) && cause.code === "EADDRNOTAVAIL") {
          settle(true);
          return;
        }
        settle(false);
      });

      server.once("listening", () => {
        server.close(() => {
          settle(true);
        });
      });

      server.listen({ host, port });

      return Effect.sync(() => {
        closeServer(server);
      });
    });

  /**
   * Reserve an ephemeral loopback port and release it immediately.
   * Returns the reserved port number.
   */
  const reserveLoopbackPort = (host = "127.0.0.1"): Effect.Effect<number, NetError> =>
    Effect.callback<number, NetError>((resume) => {
      const probe = NodeNet.createServer();
      let settled = false;

      const settle = (effect: Effect.Effect<number, NetError>) => {
        if (settled) return;
        settled = true;
        resume(effect);
      };

      probe.once("error", (cause) => {
        settle(Effect.fail(new NetError({ message: "Failed to reserve loopback port", cause })));
      });

      probe.listen(0, host, () => {
        const address = probe.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        probe.close(() => {
          if (port > 0) {
            settle(Effect.succeed(port));
            return;
          }
          settle(Effect.fail(new NetError({ message: "Failed to reserve loopback port" })));
        });
      });

      return Effect.sync(() => {
        closeServer(probe);
      });
    });

  return {
    canListenOnHost,
    isPortAvailableOnLoopback: (port) =>
      Effect.zipWith(
        canListenOnHost(port, "127.0.0.1"),
        canListenOnHost(port, "::1"),
        (ipv4, ipv6) => ipv4 && ipv6,
      ),
    reserveLoopbackPort,
    findAvailablePort: (preferred) =>
      Effect.catch(tryReservePort(preferred), () => tryReservePort(0)),
  } satisfies NetServiceShape;
};

export const layer = Layer.sync(NetService, make);

import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { isWildcardHost, listensOnLoopback, normalizeHostname } from "./hostClassification.ts";

const WILDCARD_PORT_ATTEMPTS = 8;

export class NetError extends Schema.TaggedError<NetError>()("NetError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class NetListenError extends Schema.TaggedError<NetListenError>()("NetListenError", {
  host: Schema.String,
  port: Schema.Number,
  code: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Cannot listen on ${this.host}:${this.port} (${this.code}).`;
  }
}

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
  } catch {}
};

export interface NetServiceShape {
  readonly canListenOnHost: (port: number, host: string) => Effect.Effect<boolean>;

  /** Like `canListenOnHost`, but only EADDRINUSE yields `false`; other bind errors fail. */
  readonly probeListenOnHost: (
    port: number,
    host: string,
  ) => Effect.Effect<boolean, NetListenError>;

  readonly isPortAvailableOnLoopback: (port: number) => Effect.Effect<boolean>;

  readonly hasListenerOnHost: (port: number, host: string) => Effect.Effect<boolean>;

  readonly reserveLoopbackPort: (host?: string) => Effect.Effect<number, NetError>;

  readonly findAvailablePort: (preferred: number, host?: string) => Effect.Effect<number, NetError>;
}

export class NetService extends Context.Service<NetService, NetServiceShape>()(
  "@t3tools/shared/Net/NetService",
) {}

/** @public */
export const make = () => {
  const probeListenOnHost = (port: number, host: string): Effect.Effect<boolean, NetListenError> =>
    Effect.callback<boolean, NetListenError>((resume) => {
      const server = NodeNet.createServer();
      let settled = false;

      const settle = (effect: Effect.Effect<boolean, NetListenError>) => {
        if (settled) return;
        settled = true;
        resume(effect);
      };

      server.unref();

      server.once("error", (cause) => {
        const code = isErrnoExceptionWithCode(cause) ? cause.code : "UNKNOWN";
        // Missing IPv6 addresses or kernel support do not mean the port is occupied.
        if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") {
          settle(Effect.succeed(true));
          return;
        }
        if (code === "EADDRINUSE") {
          settle(Effect.succeed(false));
          return;
        }
        settle(Effect.fail(new NetListenError({ host, port, code, cause })));
      });

      server.once("listening", () => {
        server.close(() => {
          settle(Effect.succeed(true));
        });
      });

      server.listen({ host, port });

      return Effect.sync(() => {
        closeServer(server);
      });
    });

  const canListenOnHost = (port: number, host: string): Effect.Effect<boolean> =>
    probeListenOnHost(port, host).pipe(
      Effect.catchTags({ NetListenError: () => Effect.succeed(false) }),
    );

  const hasListenerOnHost = (port: number, host: string): Effect.Effect<boolean> =>
    Effect.callback<boolean>((resume) => {
      const socket = NodeNet.createConnection({ host, port });
      let settled = false;

      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resume(Effect.succeed(value));
      };

      socket.unref();
      socket.setTimeout(250);
      socket.once("connect", () => {
        settle(true);
      });
      socket.once("error", () => {
        settle(false);
      });
      socket.once("timeout", () => {
        settle(false);
      });

      return Effect.sync(() => {
        socket.destroy();
      });
    });

  const isPortAvailableOnLoopback = Effect.fn("Net.isPortAvailableOnLoopback")(function* (
    port: number,
  ): Effect.fn.Return<boolean> {
    const hasListener = yield* Effect.zipWith(
      hasListenerOnHost(port, "127.0.0.1"),
      hasListenerOnHost(port, "::1"),
      (ipv4, ipv6) => ipv4 || ipv6,
    );
    if (hasListener) {
      return false;
    }

    return yield* Effect.zipWith(
      canListenOnHost(port, "127.0.0.1"),
      canListenOnHost(port, "::1"),
      (ipv4, ipv6) => ipv4 && ipv6,
    );
  });

  const isPortAvailableForHost = Effect.fn("Net.isPortAvailableForHost")(function* (
    port: number,
    host: string | undefined,
  ): Effect.fn.Return<boolean> {
    if (host === undefined || listensOnLoopback(host)) {
      return yield* isPortAvailableOnLoopback(port);
    }
    if (yield* hasListenerOnHost(port, host)) {
      return false;
    }
    return yield* canListenOnHost(port, host);
  });

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
    probeListenOnHost,
    isPortAvailableOnLoopback,
    hasListenerOnHost,
    reserveLoopbackPort,
    findAvailablePort: Effect.fn("Net.findAvailablePort")(function* (preferred, host) {
      const wildcardHost =
        host !== undefined && (host === "" || isWildcardHost(host))
          ? normalizeHostname(host)
          : undefined;
      if (
        preferred > 0 &&
        (yield* isPortAvailableForHost(preferred, host)) &&
        (wildcardHost === undefined || (yield* canListenOnHost(preferred, wildcardHost)))
      ) {
        return preferred;
      }
      if (wildcardHost === undefined) {
        return yield* reserveLoopbackPort(listensOnLoopback(host) ? undefined : host);
      }

      // A wildcard bind can succeed while another address family owns the localhost port.
      for (let attempt = 0; attempt < WILDCARD_PORT_ATTEMPTS; attempt += 1) {
        const port = yield* reserveLoopbackPort(wildcardHost);
        if (yield* isPortAvailableOnLoopback(port)) return port;
      }
      return yield* new NetError({ message: "Failed to find an available wildcard port" });
    }),
  } satisfies NetServiceShape;
};

export const layer = Layer.sync(NetService, make);

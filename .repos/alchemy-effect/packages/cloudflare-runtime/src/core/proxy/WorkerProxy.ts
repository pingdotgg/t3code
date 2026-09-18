import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as NodeNet from "node:net";
import * as Port from "../internal/Port.ts";
import type { RuntimeError } from "../RuntimeError.shared.ts";
import { ConfigError, SystemError } from "../RuntimeError.shared.ts";

/**
 * A stable local address for a Worker whose runtime comes and goes.
 *
 * A dev Worker's workerd is replaced on every code change (make-before-break),
 * so its own port moves. The proxy owns the port the user sees and relays each
 * accepted connection to whatever upstream is currently {@link
 * WorkerProxyInstance.set}: a plain byte pipe over `node:net`, with no HTTP
 * parsing in between. HTTP/1.1, streaming bodies and WebSocket upgrades all
 * pass through untouched, and the Worker receives the client's real `Host`
 * header, so `request.url` inside it is the public URL.
 *
 * Deliberately NOT `node:http`: Bun's `node:http` shim (1.3.13) delivers an
 * upstream 101 as a plain `response` and loses writes on a server `upgrade`
 * socket, which kills every proxied WebSocket whenever the host process runs
 * on Bun. A byte pipe never enters that code path.
 *
 * Connections accepted while no upstream is set are parked until one is
 * set (a worker restart) or the client gives up; that is the queue that
 * covers the restart gap. Whatever the client sends before its upstream is
 * connected is held by the proxy itself and replayed first: Bun's
 * `net.Socket` (1.3.13) discards bytes that arrive before a `data` listener
 * exists, where Node buffers them, so the proxy never relies on the socket
 * to do the holding. Setting a different upstream destroys the connections
 * spliced to the previous one — with make-before-break the old runtime is
 * torn down right after, so an in-flight exchange there would be reset
 * anyway, and a keep-alive connection must not stay pinned to it.
 */
export class WorkerProxy extends Context.Service<
  WorkerProxy,
  {
    readonly serve: (
      options?: ServeOptions,
    ) => Effect.Effect<WorkerProxyInstance, RuntimeError, Scope.Scope>;
  }
>()("cloudflare-runtime/proxy/WorkerProxy") {}

export interface ServeOptions {
  /**
   * The port to serve the proxy on. If not provided, a random port will be chosen.
   * @default 0
   */
  readonly port?: number;
  /**
   * Whether to throw an error if the port is not available.
   * @default false
   */
  readonly strictPort?: boolean;
  /**
   * The host to serve the proxy on.
   * @default "localhost"
   */
  readonly host?: string;
  /**
   * How long a connection accepted while no upstream is set waits for one
   * before it is answered with a 502.
   * @default "2 minutes"
   */
  readonly pendingTimeout?: Duration.Input;
}

/** Maximum number of port-collision retries for a single `serve` call. */
const MAX_SERVE_ATTEMPTS = 8;

const DEFAULT_PENDING_TIMEOUT = Duration.minutes(2);

/**
 * Bytes held for a client whose upstream is not connected yet, before the
 * proxy stops reading from it. A request head is a few KB; a body this
 * large arriving before the worker is up simply waits in the kernel.
 */
const HOLD_LIMIT = ByteSize.mebibytes(1);

export interface WorkerProxyInstance {
  readonly url: URL;
  /** Route new connections to `upstream` (plain HTTP); release parked ones. */
  readonly set: (upstream: URL) => Effect.Effect<void>;
  /** Park new connections until the next `set`. Spliced connections are left alone. */
  readonly unset: () => Effect.Effect<void>;
  /**
   * Answer parked connections, and new ones until the next `set`, with a 502
   * carrying `message` right away: the upstream is not coming (a bundle
   * error, a dead dev server), so waiting out the pending timeout would
   * only hide the cause.
   */
  readonly fail: (message: string) => Effect.Effect<void>;
}

/** A `set` URL, resolved once into what `net.connect` needs. */
interface Upstream {
  readonly url: URL;
  readonly host: string;
  readonly port: number;
}

/** Resolves once the socket has emitted `close`; interruption stops waiting. */
const closed = (socket: NodeNet.Socket) =>
  Effect.callback<void>((resume) => {
    if (socket.destroyed) return resume(Effect.void);
    const done = () => resume(Effect.void);
    socket.once("close", done);
    return Effect.sync(() => {
      socket.off("close", done);
    });
  });

/** A connected upstream socket, or the connect failure. Interruption destroys it. */
const connect = (to: Upstream) =>
  Effect.callback<NodeNet.Socket, SystemError>((resume) => {
    const socket = NodeNet.connect({ host: to.host, port: to.port });
    // Errors after the connect phase are the pipe's business; never unhandled.
    socket.on("error", () => {});
    const failed = (cause: Error) =>
      resume(
        Effect.fail(
          new SystemError({
            subtag: "WorkerProxyConnect",
            message: `Failed to reach the worker (upstream address: ${to.url})`,
            cause,
          }),
        ),
      );
    socket.once("error", failed);
    socket.once("connect", () => {
      socket.off("error", failed);
      resume(Effect.succeed(socket));
    });
    return Effect.sync(() => socket.destroy());
  });

interface Relay {
  /** Runs one accepted client connection to completion in its own fiber. */
  readonly accept: (socket: NodeNet.Socket) => void;
  readonly set: (upstream: Upstream) => Effect.Effect<void>;
  readonly unset: Effect.Effect<void>;
  readonly fail: (message: string) => Effect.Effect<void>;
  /** Interrupts every connection, destroying its sockets. */
  readonly close: Effect.Effect<void>;
}

/**
 * The relay's whole state is one `Deferred`: pending while no upstream is
 * set (connections park on it), succeeded with the upstream once `set`, and
 * failed with the 502 once `fail`. Each `set`/`fail` settles the deferred
 * parked connections are waiting on and installs a fresh, already-settled
 * one for those that follow, so a new object means the upstream moved.
 */
const makeRelay = (pendingTimeout: Duration.Duration): Relay => {
  let current = Deferred.makeUnsafe<Upstream, SystemError>();
  const timedOut = new SystemError({
    subtag: "WorkerProxyUpstream",
    message: `No upstream configured for the worker proxy after ${Duration.format(pendingTimeout)}`,
  });
  const connections = new Set<Fiber.Fiber<void>>();
  /** Connections spliced to an upstream, so a `set` elsewhere can reset them. */
  const pinned = new Set<{
    readonly target: Upstream;
    readonly socket: NodeNet.Socket;
  }>();

  const settle = (
    complete: (
      deferred: Deferred.Deferred<Upstream, SystemError>,
    ) => Effect.Effect<boolean>,
  ) =>
    Effect.gen(function* () {
      const waiting = current;
      current = Deferred.makeUnsafe<Upstream, SystemError>();
      yield* complete(current);
      yield* complete(waiting);
    });

  const connection = Effect.fnUntraced(function* (socket: NodeNet.Socket) {
    yield* Effect.addFinalizer(() => Effect.sync(() => socket.destroy()));
    // A client that goes away is not an event anyone else needs to hear about.
    socket.on("error", () => {});

    // Whatever the client sends before its upstream is connected is held
    // here and replayed first — see the module doc on Bun. Read from the
    // very first tick; past the limit the rest waits in the kernel.
    const held: Array<Buffer> = [];
    let heldBytes = 0n;
    const collect = (chunk: Buffer) => {
      held.push(chunk);
      heldBytes += BigInt(chunk.length);
      if (heldBytes > HOLD_LIMIT) socket.pause();
    };
    socket.on("data", collect);

    // Wait for an upstream (immediate when one is set), then connect to it.
    // Nothing has been forwarded yet, so a refused connect is safe to retry
    // for every method: if the upstream moved meanwhile (a restart landed
    // between accept and connect), follow it. Otherwise the failure, or
    // the timeout, or the message from `fail`, becomes the 502.
    let awaited = current;
    const spliced = yield* Effect.suspend(() => {
      awaited = current;
      return Deferred.await(awaited).pipe(
        Effect.timeoutOrElse({
          duration: pendingTimeout,
          orElse: () => Effect.fail(timedOut),
        }),
        Effect.flatMap((target) =>
          Effect.map(connect(target), (upstream) => ({ target, upstream })),
        ),
      );
    }).pipe(
      Effect.retry({ while: () => awaited !== current }),
      Effect.catch((error) =>
        Effect.sync(() => {
          // The one piece of HTTP the proxy speaks: a fixed 502 on the raw
          // socket. The collector keeps consuming so no unread inbound
          // bytes are left at close (that would make the kernel send RST
          // instead of FIN and could discard the response before the
          // client reads it).
          const body = JSON.stringify({
            ok: false,
            error: { _tag: "ProxyError", message: error.message, status: 502 },
          });
          held.length = 0;
          socket.resume();
          socket.end(
            [
              "HTTP/1.1 502 Bad Gateway",
              "Content-Type: application/json",
              `Content-Length: ${Buffer.byteLength(body)}`,
              "Connection: close",
              "",
              body,
            ].join("\r\n"),
          );
          return undefined;
        }),
      ),
    );

    if (spliced !== undefined) {
      const { target, upstream } = spliced;
      yield* Effect.addFinalizer(() => Effect.sync(() => upstream.destroy()));
      const pin = { target, socket };
      pinned.add(pin);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          pinned.delete(pin);
        }),
      );
      // Hand over what the client already sent, then let the pipe take
      // the rest. Detaching the collector and attaching the pipe happen
      // in one synchronous step, so no chunk can slip between them.
      socket.off("data", collect);
      for (const chunk of held) upstream.write(chunk);
      held.length = 0;
      socket.pipe(upstream);
      socket.resume();
      upstream.pipe(socket);
      // The upstream going away ends the client; the finalizers do the rest.
      upstream.on("error", () => socket.destroy());
      upstream.on("close", () => socket.destroy());
    }
    // From here the socket does the talking; the client closing ends the
    // fiber (see `accept`), and the finalizers destroy both ends.
    yield* Effect.never;
  });

  return {
    accept: (socket) => {
      // The connection lives exactly as long as the client socket: whatever
      // it is doing when the client closes is interrupted, and the scope
      // destroys both sockets.
      const fiber = Effect.runFork(
        Effect.race(connection(socket), closed(socket)).pipe(Effect.scoped),
      );
      connections.add(fiber);
      fiber.addObserver(() => connections.delete(fiber));
    },
    set: (to) =>
      settle((deferred) => Deferred.succeed(deferred, to)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            // Whatever is still pinned to another upstream is about to be torn down.
            for (const pin of pinned) {
              if (pin.target.url.href !== to.url.href) pin.socket.destroy();
            }
          }),
        ),
      ),
    // Back to pending, unless nothing is set (parked connections keep waiting).
    unset: Effect.sync(() => {
      if (Deferred.isDoneUnsafe(current)) {
        current = Deferred.makeUnsafe<Upstream, SystemError>();
      }
    }),
    fail: (message) =>
      settle((deferred) =>
        Deferred.fail(
          deferred,
          new SystemError({ subtag: "WorkerProxyUpstream", message }),
        ),
      ),
    close: Fiber.interruptAll(connections),
  };
};

const listen = (relay: Relay, host: string, port: number) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server, ConfigError | SystemError>((resume) => {
      const server = NodeNet.createServer(relay.accept);
      server.once("error", (error: NodeJS.ErrnoException) => {
        resume(
          Effect.fail(
            error.code === "EADDRINUSE" || error.code === "EACCES"
              ? new ConfigError({
                  subtag: "AddressInUse",
                  message: `Address ${host}:${port} is already in use.`,
                  cause: error,
                })
              : new SystemError({
                  subtag: "WorkerProxyListen",
                  message: `Failed to listen on ${host}:${port} for the worker proxy.`,
                  cause: error,
                }),
          ),
        );
      });
      server.listen({ host, port, exclusive: true }, () =>
        resume(Effect.succeed(server)),
      );
      return Effect.sync(() => server.close());
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

export const WorkerProxyLive = Layer.effect(
  WorkerProxy,
  Effect.gen(function* () {
    const ports = yield* Port.make({ cache: true });

    // `localhost` resolves to BOTH 127.0.0.1 and ::1, and browsers prefer
    // IPv6. A proxy bound only on 127.0.0.1 leaves `[::1]:port` free for any
    // other process (e.g. a framework dev server hunting from its default
    // port) to claim — after which `http://localhost:port` silently serves
    // that other process instead of (or interleaved with) the proxy. When
    // serving on the loopback default, bind an additional `[::1]` socket so
    // the proxy owns its port on both address families. Machines without an
    // IPv6 loopback are detected once and skip the extra socket.
    const ipv6Loopback = yield* Effect.callback<boolean>((resume) => {
      const server = NodeNet.createServer();
      server.once("error", () => resume(Effect.succeed(false)));
      server.listen({ port: 0, host: "::1", exclusive: true }, () =>
        server.close(() => resume(Effect.succeed(true))),
      );
      return Effect.sync(() => server.close());
    });

    const normalizeOptions = Effect.fnUntraced(function* (
      options: ServeOptions,
    ) {
      const host = options.host ?? "127.0.0.1";
      const strictPort = options.strictPort ?? false;
      return {
        port:
          options.port && options.strictPort
            ? yield* ports.check(options.port)
            : options.port
              ? // A configured (non-strict) port: a dev-session restart races
                // the previous session's teardown, and an instant fallback
                // would silently shift every configured port in the stack up
                // by one in nondeterministic order — serving the wrong app on
                // the ports the user knows. Wait out the teardown before
                // falling back to the hunt (the caller warns on drift).
                yield* ports
                  .waitFor(options.port)
                  .pipe(Effect.catch(() => ports.find(options.port!)))
              : yield* ports.find(0),
        host,
        strictPort,
        // Dual-bind only for the loopback default — an explicit host is
        // served verbatim.
        ipv6: options.host === undefined && ipv6Loopback,
        pendingTimeout: Duration.fromInputUnsafe(
          options.pendingTimeout ?? DEFAULT_PENDING_TIMEOUT,
        ),
      };
    });
    type ResolvedOptions = Effect.Success<ReturnType<typeof normalizeOptions>>;

    const serve = Effect.fnUntraced(function* ({
      host,
      port,
      ipv6,
      pendingTimeout,
    }: ResolvedOptions) {
      const relay = makeRelay(pendingTimeout);
      yield* listen(relay, host, port);
      if (ipv6) {
        // The IPv6 half of `localhost` (see `ipv6Loopback` above). The port
        // was probed across both families by `ports.find`/`check`, so this
        // bind only fails on a genuine race — handled by `serveWithRetry`
        // like any other collision.
        yield* listen(relay, "::1", port);
      }
      // Registered after the listeners so it runs BEFORE them on close:
      // `server.close` only completes once every connection is gone.
      yield* Effect.addFinalizer(() => relay.close);
      return {
        relay,
        url: new URL(
          `http://${host === "127.0.0.1" ? "localhost" : host}:${port}`,
        ),
      };
    });

    // Each attempt binds in its own child scope: a collision closes that
    // scope (releasing any listener the attempt did get, e.g. the IPv4 half
    // when the IPv6 bind raced), the winner's scope lives on with the
    // caller's. Every attempt is a plain bind, so retrying is cheap, but it
    // MUST stay bounded: an environmental failure that keeps reporting the
    // port as taken would otherwise scan forever.
    const serveWithRetry = Effect.fnUntraced(function* (
      options: ResolvedOptions,
    ) {
      const parent = yield* Effect.scope;
      let port: number | undefined;
      return yield* Effect.gen(function* () {
        port = port === undefined ? options.port : yield* ports.find(port + 1);
        const child = yield* Scope.fork(parent);
        return yield* serve({ ...options, port }).pipe(
          Scope.provide(child),
          Effect.tapError(() => Scope.close(child, Exit.void)),
        );
      }).pipe(
        Effect.retry({
          while: (error) =>
            error._tag === "ConfigError" &&
            error.subtag === "AddressInUse" &&
            !options.strictPort &&
            port !== undefined &&
            port <= Port.MAX_PORT,
          times: MAX_SERVE_ATTEMPTS - 1,
        }),
      );
    });

    return WorkerProxy.of({
      serve: Effect.fn("WorkerProxy.serve")(function* (options = {}) {
        const resolved = yield* normalizeOptions(options);
        const { relay, url } = yield* serveWithRetry(resolved);
        if (
          options.port !== undefined &&
          options.port !== 0 &&
          Number(url.port) !== options.port
        ) {
          yield* Effect.logWarning(
            `Port ${options.port} is in use by another process; serving on ${url.port} instead. Stop the other process, pick a different port, or set \`strictPort: true\` to fail instead.`,
          );
        }
        return {
          url,
          set: (upstream) =>
            relay.set({
              url: upstream,
              // `URL.hostname` keeps the brackets on IPv6 literals; `net.connect` does not want them.
              host: upstream.hostname.replace(/^\[(.*)\]$/, "$1"),
              port: Number(upstream.port),
            }),
          unset: () => relay.unset,
          fail: relay.fail,
        } satisfies WorkerProxyInstance;
      }),
    });
  }),
);

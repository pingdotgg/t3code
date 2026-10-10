import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import { ConfigError, SystemError } from "../RuntimeError.shared.ts";

export const MAX_PORT = 65535;

/**
 * Whether the given Vite version treats `server.port: 0` as a true
 * OS-assigned random port (vitejs/vite#23158, shipped in Vite 8.2.1).
 * Older Vite treats `0` as "no port given" and hunts upward from its 5173
 * default — colliding with (or IPv6-shadowing) user-facing dev ports.
 *
 * Callers drive the PROJECT's Vite install, so this is a runtime check on
 * the loaded module's `version` export: prefer `port: 0` (race-free at
 * bind) when supported, fall back to an ephemeral-port probe otherwise.
 */
export const viteSupportsPortZero = (
  version: string | null | undefined,
): boolean => {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return (
    major > 8 || (major === 8 && (minor > 2 || (minor === 2 && patch >= 1)))
  );
};

/**
 * Upper bound on how many candidate ports `find` scans past the requested
 * starting port. An unbounded scan (up to `MAX_PORT`) multiplied by the
 * per-port availability probes is a socket storm: on Windows CI, where an
 * environmental failure (`ENOBUFS` ephemeral-port/buffer exhaustion) makes
 * *every* probe fail, it would churn through hundreds of thousands of socket
 * binds and amplify the very exhaustion that caused it.
 */
export const MAX_PORT_SEARCH_ATTEMPTS = 128;

/** The bind failed because the address is genuinely taken (scanning to the next port can help). */
const ADDRESS_IN_USE_CODES: ReadonlySet<string> = new Set([
  "EADDRINUSE",
  "EACCES",
]);

/**
 * The bind failed because this host doesn't exist on this machine (e.g. `::`
 * without IPv6). The host can't conflict with anything, so it must not veto
 * the port — otherwise every port would appear "in use" and the search would
 * scan the whole port space.
 */
const UNSUPPORTED_HOST_CODES: ReadonlySet<string> = new Set([
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "EINVAL",
  "ENOTFOUND",
]);

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : undefined;

/**
 * Whether a failed bind means the requested host is unavailable rather than
 * the port being occupied. Node reports a coded error for this, while Bun can
 * reject an IPv6 bind without a `code` on machines with no IPv6 stack.
 */
export const isUnsupportedHostError = (
  error: unknown,
  host: string | undefined,
  hasIPv6Interface?: boolean,
): boolean => {
  const code = errorCode(error);
  if (code !== undefined) return UNSUPPORTED_HOST_CODES.has(code);
  return (
    host !== undefined &&
    NodeNet.isIPv6(host) &&
    !(
      hasIPv6Interface ??
      Object.values(NodeOs.networkInterfaces()).some(
        (addresses) =>
          addresses?.some((address) => address.family === "IPv6") ?? false,
      )
    )
  );
};

export interface Ports {
  /**
   * Finds an available port starting from the given one.
   */
  readonly find: (port: number) => Effect.Effect<number>;
  /**
   * Checks if a port is available and reserves it if it is; returns an error otherwise.
   */
  readonly check: (port: number) => Effect.Effect<number, ConfigError>;
  /**
   * Waits for a specific port to become available (uncached probes on a
   * short interval), reserving it on success. Fails with `AddressInUse`
   * when the grace window elapses — or immediately when the port is
   * reserved by this process group, since the holder won't release it.
   *
   * This is the allocator for user-configured ports: a dev-session restart
   * races the previous session's teardown, and without a grace window the
   * configured port silently drifts — cascading every configured port in
   * the stack up by one in nondeterministic order.
   */
  readonly waitFor: (port: number) => Effect.Effect<number, ConfigError>;
  /**
   * Marks a port as occupied for the lifetime of the cache, preventing it from being assigned to another worker.
   * Note that this is best-effort; the caller should include retry logic to handle race conditions.
   */
  readonly reserve: (port: number) => Effect.Effect<void>;
}

const HOSTS: Set<string> = new Set([
  "0.0.0.0",
  "::",
  "0000:0000:0000:0000:0000:0000:0000:0000",
  "localhost",
  "127.0.0.1",
  "::1",
  "0000:0000:0000:0000:0000:0000:0000:0001",
]);

interface PortsOptions {
  /** Prevents redundant lookups and helps with race conditions; should only be disabled for testing. */
  readonly cache: boolean;
}

/**
 * Process-wide port coordination.
 *
 * Every runtime instance constructs its own {@link Ports}, but they all
 * allocate from the same OS port space. With per-instance state, two
 * instances can probe the same free port in the same tick and hand it to
 * two workerd processes — and near-simultaneous `bind()`s BOTH succeed on
 * macOS (the SO_REUSEADDR bind/listen window), leaving two listeners
 * silently splitting the port's traffic. A shared search lock plus a
 * shared reservation table (port → expiry) makes allocation atomic across
 * instances; the reservation outlives the probe long enough for the
 * winning workerd to establish its listener, after which real binds fail
 * cleanly for everyone else.
 */
const RESERVATION_TTL_MS = 30_000;
/**
 * Grace window for `waitFor`: ~3s of 250ms probes. A killed dev session
 * releases its listeners well within this; a genuinely-occupied port only
 * delays that one worker's startup by the window before falling back.
 */
const WAIT_FOR_INTERVAL = "250 millis";
const WAIT_FOR_ATTEMPTS = 12;
const globalSearchLock = Semaphore.makeUnsafe(1);
const globalReservations = new Map<number, number>();
const isReserved = (port: number) => {
  const expiry = globalReservations.get(port);
  if (expiry === undefined) return false;
  if (expiry <= Date.now()) {
    globalReservations.delete(port);
    return false;
  }
  return true;
};

export const make = (options: PortsOptions) =>
  Effect.gen(function* () {
    const addressInUseError = (port: number) =>
      new ConfigError({
        subtag: "AddressInUse",
        message: `Could not bind to port ${port} (already in use).`,
        hint: "Pick a different port or stop the process using it.",
        detail: { address: `localhost:${port}` },
      });
    const bind = (port: number, host?: string) =>
      Effect.callback<number, ConfigError>((resume) => {
        const server = NodeNet.createServer();
        server.once("error", (error) => {
          server.close(() => {
            const code = errorCode(error);
            if (isUnsupportedHostError(error, host)) {
              // The host isn't available on this machine, so it can't hold the
              // port either — treat the probe as a success.
              return resume(Effect.succeed(port));
            }
            if (code === undefined || ADDRESS_IN_USE_CODES.has(code)) {
              return resume(Effect.fail(addressInUseError(port)));
            }
            // Any other failure (ENOBUFS, EMFILE, ...) is environmental:
            // scanning to the next port cannot succeed and only multiplies
            // socket churn, so stop the search outright.
            return resume(
              Effect.die(
                new SystemError({
                  subtag: "PortBindFailed",
                  message: `Could not bind to port ${port} (${code}).`,
                  hint: "The system is out of socket resources (or the network stack rejected the bind). Free up resources and retry.",
                  detail: { port, host, code, cause: error },
                }),
              ),
            );
          });
        });
        server.listen({ port, host, exclusive: true }, () => {
          const { port } = server.address() as NodeNet.AddressInfo;
          server.close(() => resume(Effect.succeed(port)));
        });
        return Effect.sync(() => server.close());
      });
    const cache = yield* Cache.makeWith(
      (port: number) =>
        Effect.forEach(HOSTS, (host) => bind(port, host)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      {
        capacity: options.cache ? Infinity : 0,
        // Cache for 30 seconds if the port is *not* available to prevent redundant lookups.
        // If a port *is* available, we don't cache it since it will likely be claimed shortly after lookup.
        timeToLive: (exit) =>
          exit._tag === "Success" && exit.value ? 0 : "30 seconds",
      },
    );
    const reserveLocal = (port: number) => Cache.set(cache, port, false);
    const reserve = (port: number) =>
      Effect.sync(() => {
        globalReservations.set(port, Date.now() + RESERVATION_TTL_MS);
      }).pipe(Effect.andThen(reserveLocal(port)));
    // Serializes the search loop so that concurrent lookups for the same
    // starting port each reserve a distinct port. Without this, concurrent
    // callers all observe the starting port as available and return it. On
    // Windows this is the only safeguard, since duplicate binds don't fail
    // there and so the higher-level bind-and-retry fallback never kicks in.
    // The lock and the reservation table are process-wide (see above) so
    // concurrent runtime instances coordinate too.
    const searchLock = globalSearchLock;
    const search = Effect.fn(function* (start: number) {
      let port = start;
      const limit = Math.min(MAX_PORT, start + MAX_PORT_SEARCH_ATTEMPTS - 1);
      while (port <= limit) {
        const available = !isReserved(port) && (yield* Cache.get(cache, port));
        if (available) {
          yield* reserve(port);
          return port;
        }
        yield* Effect.logDebug(
          `Port ${port} is not available, trying ${port + 1}...`,
        );
        port++;
      }
      // This should essentially never happen, so it's a `die` rather than a `fail`.
      return yield* Effect.die(
        new SystemError({
          subtag: "PortExhausted",
          message: `No available port found in the range ${start}-${limit}.`,
          hint: "Free up a port in this range or pick a different starting port.",
          detail: { start, limit },
        }),
      );
    }, searchLock.withPermits(1));
    // Uncached availability probe across all local hosts — `waitFor` polls
    // with it, so the 30s negative cache must not poison the retries.
    const probe = (port: number) =>
      Effect.forEach(HOSTS, (host) => bind(port, host)).pipe(Effect.as(port));
    return {
      find: Effect.fn(function* (port) {
        if (port === 0) {
          // OS-assigned ephemeral ports are unique by construction — no
          // global reservation, so a caller handed one can immediately
          // request it back (e.g. `find(0)` then `serve({ port })`).
          return yield* bind(port).pipe(Effect.tap(reserveLocal));
        }
        return yield* search(port);
      }),
      waitFor: (port) =>
        Effect.suspend(() =>
          // Reserved in-process (at entry or mid-wait): the holder keeps it
          // for the cache lifetime, so waiting cannot succeed (e.g. two
          // workers configured the same port) — fail and let the caller
          // fall back. The retry predicate re-checks so a reservation
          // arriving during the grace window also stops the wait.
          isReserved(port) ? Effect.fail(addressInUseError(port)) : probe(port),
        ).pipe(
          Effect.retry({
            while: (): boolean => !isReserved(port),
            schedule: Schedule.spaced(WAIT_FOR_INTERVAL),
            times: WAIT_FOR_ATTEMPTS,
          }),
          Effect.tap(() => reserve(port)),
        ),
      check: (port) =>
        Effect.suspend(() =>
          isReserved(port)
            ? Effect.fail(addressInUseError(port))
            : Cache.get(cache, port).pipe(
                Effect.flatMap((available) =>
                  available
                    ? reserve(port).pipe(Effect.as(port))
                    : Effect.fail(addressInUseError(port)),
                ),
              ),
        ),
      reserve,
    } as Ports;
  });

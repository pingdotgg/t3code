import type * as cf from "@cloudflare/workers-types";
import { makeFetchRpcStub } from "alchemy/Rpc";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { HttpClientError } from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { HttpServerError } from "effect/http/HttpServerError";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Sink from "effect/Sink";
import type * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import {
  fromCloudflareFetcher,
  type Fetcher,
  type SocketAddress,
  type SocketOptions,
} from "../Fetcher.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import {
  ContainerCrashedError,
  ContainerError,
  ContainerNotRunningError,
  ContainerRateLimitedError,
  NoContainerInstanceError,
  type ContainerStartupOptions,
} from "./Container.ts";
import { httpSchemePort } from "./ContainerPlatform.ts";

export type ContainerExecOptions = cf.ContainerExecOptions;
export type ContainerExecOutput = cf.ExecOutput;
export type ContainerInfo = cf.ContainerInfo;
export type ContainerSnapshot = cf.ContainerSnapshot;
export type ContainerSnapshotOptions = cf.ContainerSnapshotOptions;

/** Errors a container `start` can fail with. */
export type ContainerStartError =
  | ContainerError
  | NoContainerInstanceError
  | ContainerRateLimitedError;

/** Errors a container port can fail with before the request reaches it. */
export type ContainerPortError = ContainerError | ContainerNotRunningError | ContainerCrashedError;

/**
 * A port inside the container. Each request waits until the port accepts
 * connections, then is sent exactly once. A port never starts the container:
 * a stopped container fails with {@link ContainerNotRunningError}.
 */
export interface ContainerPort {
  fetch(
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    ContainerPortError | HttpClientError,
    RuntimeContext
  >;
  fetch(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    ContainerPortError | HttpServerError,
    RuntimeContext
  >;
  connect(address: SocketAddress | string, options?: SocketOptions): Socket.Socket;
}

/** A native process, owned by the scope that called {@link ContainerClient.exec}. */
export interface ContainerProcess {
  /** Process ID inside the container. */
  readonly pid: number;
  /** Whether the process has a pseudo-terminal. */
  readonly isPty: boolean;
  /** Piped standard input. Completing the sink closes stdin. */
  readonly stdin: Sink.Sink<void, Uint8Array, never, ContainerError, RuntimeContext> | undefined;
  /** Piped standard output. Consume this or call output(), not both. */
  readonly stdout: Stream.Stream<Uint8Array, ContainerError, RuntimeContext> | undefined;
  /** Standard error, absent when ignored or combined with stdout. */
  readonly stderr: Stream.Stream<Uint8Array, ContainerError, RuntimeContext> | undefined;
  /** Wait for completion. Nonzero exit codes are returned normally. */
  readonly exitCode: Effect.Effect<number, ContainerError, RuntimeContext>;
  /** Collect output once. For large output, consume stdout and stderr concurrently. */
  output(): Effect.Effect<ContainerExecOutput, ContainerError, RuntimeContext>;
  /** Signal this process. Defaults to SIGTERM; child processes are not signaled. */
  kill(signal?: number): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Resize the process's pseudo-terminal. */
  resize(cols: number, rows: number): Effect.Effect<void, ContainerError, RuntimeContext>;
}

/**
 * The container bound to the current Durable Object — what `yield* Sandbox`
 * returns. Binding never starts the container: call {@link start} before
 * using it. `start` is idempotent and coordinated across every handle in the
 * Durable Object, so calling it at the top of each operation is cheap.
 *
 * A Durable Object has one container instance. When several Durable
 * Object-managed Containers are bound to it, each handle starts its own image,
 * and every handle controls that same instance: start one image at a time.
 */
export interface ContainerClient {
  /**
   * This Container's prepared image reference, the key `start()` selects by
   * default. Fails with {@link ContainerError} when the Container publishes no
   * image to this Durable Object (fleet Containers and Containers without an
   * image source).
   */
  readonly image: Effect.Effect<string, ContainerError, RuntimeContext>;
  /** Whether the container process is running; this does not imply port readiness. */
  readonly running: Effect.Effect<boolean, ContainerError, RuntimeContext>;
  /**
   * Start the container unless it is already running. Concurrent calls start
   * it once. Returns before ports are ready; {@link getTcpPort} waits for them.
   * Options apply only when this call actually starts the container.
   *
   * A Durable Object-managed Container starts its own {@link image} unless
   * `options` names an `image` or a `containerSnapshot`. A no-op while any
   * image is running: `destroy()` first to switch images.
   */
  start(
    options?: ContainerStartupOptions,
  ): Effect.Effect<void, ContainerStartError, RuntimeContext>;
  /** Stop the container immediately. */
  destroy(error?: unknown): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Signal the container's main process. */
  signal(signo: number): Effect.Effect<void, ContainerError, RuntimeContext>;
  /**
   * Wait for the container to exit, preserving failures in the Effect error channel.
   * Cloudflare often reports a failed start here rather than from `start`, so a start
   * it had no instance for fails with `NoContainerInstanceError` and a rate-limited one
   * with `ContainerRateLimitedError`, as `start` does.
   */
  monitor(): Effect.Effect<void, ContainerStartError, RuntimeContext>;
  /** Running image and labels, or null when stopped. */
  inspect(): Effect.Effect<ContainerInfo | null, ContainerError, RuntimeContext>;
  /** A port inside the container whose requests wait until it accepts connections. */
  getTcpPort(port: number): Effect.Effect<ContainerPort, never, RuntimeContext>;
  /**
   * Execute an argument vector without a shell. The container must already
   * be started. Scope closure kills this process with SIGKILL; descendants
   * are not signaled. Supply an explicit shell when shell syntax is needed.
   */
  exec(
    cmd: string[],
    options?: ContainerExecOptions,
  ): Effect.Effect<ContainerProcess, ContainerError, RuntimeContext | Scope.Scope>;
  /**
   * Save the writable root filesystem. Memory and running processes are not
   * captured. Restore by passing the handle to start({ containerSnapshot }).
   */
  snapshotContainer(
    options?: ContainerSnapshotOptions,
  ): Effect.Effect<ContainerSnapshot, ContainerError, RuntimeContext>;
  /** Set the idle timeout for this Durable Object instance, in milliseconds. */
  setInactivityTimeout(
    durationMs: number | bigint,
  ): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Intercept matching outbound HTTP requests. Re-register after each start. */
  interceptOutboundHttp(
    addr: string,
    binding: Fetcher,
  ): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Intercept all outbound HTTP requests. Re-register after each start. */
  interceptAllOutboundHttp(binding: Fetcher): Effect.Effect<void, ContainerError, RuntimeContext>;
  /** Intercept matching outbound HTTPS requests. Re-register after each start. */
  interceptOutboundHttps(
    addr: string,
    binding: Fetcher,
  ): Effect.Effect<void, ContainerError, RuntimeContext>;
}

/**
 * Names the container handle reserves. A container's RPC shape cannot
 * declare them: the handle's own method would shadow the RPC call.
 */
export type ReservedContainerKey = keyof ContainerClient | "~alchemy/Id";

const containerError = (cause: unknown) =>
  new ContainerError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

// Every constant below is taken from Cloudflare's own `@cloudflare/containers`
// runtime (`dist/lib/container.js`) so readiness matches `startAndWaitForPorts`:
//   INSTANCE_POLL_INTERVAL_MS   = 300    → fixed poll interval
//   PING_TIMEOUT_MS             = 5_000  → per-probe cap
//   TIMEOUT_TO_GET_CONTAINER_MS = 8_000  → find + start an instance
//   TIMEOUT_TO_GET_PORTS_MS     = 20_000 → wait for the port to listen
const READINESS_POLL_INTERVAL = Duration.millis(300);
const READINESS_PROBE_TIMEOUT = Duration.seconds(5);
const GET_CONTAINER_RETRIES = Math.ceil(8_000 / 300);
const PORT_READY_RETRIES = Math.ceil(20_000 / 300);
// When rate limited, back off hard: hammering `start()` only prolongs it.
const RATE_LIMIT_BACKOFF = Duration.seconds(2);
const RATE_LIMIT_RETRIES = 5;
// Covers the transient "Network connection lost" window on the real request.
const REQUEST_RETRIES = 3;

// Native classifies the same message phrases via `isErrorOfType`.
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).toLowerCase();
// Native does not match the second phrase: Cloudflare sends it when the
// application is at its `max_instances` cap.
const isNoInstanceError = (e: unknown) =>
  errorText(e).includes(
    "there is no container instance that can be provided to this durable object",
  ) || errorText(e).includes("maximum number of running container instances exceeded");
const isRateLimitedError = (e: unknown) =>
  errorText(e).includes("you are requesting too many containers per second");

const classifyStartError = (cause: unknown): ContainerStartError =>
  isRateLimitedError(cause)
    ? new ContainerRateLimitedError({ message: "Rate limited starting container", cause })
    : isNoInstanceError(cause)
      ? new NoContainerInstanceError({ message: "No container instance available", cause })
      : containerError(cause);

/**
 * Per-container coordination: a start mutex and the ports confirmed ready
 * since the last start. Keyed on the native `ctx.container`, which is one
 * object per Durable Object instance, so every handle in the object (several
 * layers may each `yield*` the same container) shares it. Racing callers then
 * never both call `container.start()` ("already running",
 * cloudflare/containers#173).
 */
const coordination = new WeakMap<
  object,
  { readonly startMutex: Semaphore.Semaphore; readonly readyPorts: Set<number> }
>();

const coordinationFor = (container: cf.Container) => {
  let entry = coordination.get(container);
  if (!entry) {
    entry = { startMutex: Semaphore.makeUnsafe(1), readyPorts: new Set<number>() };
    coordination.set(container, entry);
  }
  return entry;
};

// workers-types and the DOM lib declare the same web stream / AbortSignal
// classes in separate modules, so values crossing between them need a cast.
const toReadable = (
  stream: cf.ReadableStream | null | undefined,
): Stream.Stream<Uint8Array, ContainerError> | undefined => {
  if (!stream) return undefined;
  return Stream.fromReadableStream({
    evaluate: () => stream as unknown as ReadableStream<Uint8Array>,
    onError: containerError,
  });
};

const toWritable = (
  stream: cf.WritableStream | null | undefined,
): Sink.Sink<void, Uint8Array, never, ContainerError> | undefined => {
  if (!stream) return undefined;
  return Sink.fromWritableStream({
    evaluate: () => stream as unknown as WritableStream<Uint8Array>,
    onError: containerError,
  });
};

/** Abort the exec when either the Effect is interrupted or the caller aborts. */
const combineSignals = (
  interrupt: AbortSignal,
  caller: cf.AbortSignal | undefined,
): cf.AbortSignal => {
  const combined = caller
    ? AbortSignal.any([interrupt, caller as unknown as AbortSignal])
    : interrupt;
  return combined as unknown as cf.AbortSignal;
};

const fromProcess = (process: cf.ExecProcess): ContainerProcess => {
  // Once the exit code is observed, the PID may be reused: stop signaling it.
  let exited = false;
  const markExited = Effect.sync(() => {
    exited = true;
  });

  return {
    pid: process.pid,
    isPty: process.isPty,
    stdin: toWritable(process.stdin),
    stdout: toReadable(process.stdout),
    stderr: toReadable(process.stderr),
    exitCode: Effect.tryPromise({
      try: () => process.exitCode,
      catch: containerError,
    }).pipe(Effect.tap(() => markExited)),
    output: () =>
      Effect.tryPromise({
        try: () => process.output(),
        catch: containerError,
      }).pipe(Effect.tap(() => markExited)),
    kill: (signal) =>
      Effect.try({
        try: () => {
          if (!exited) process.kill(signal);
        },
        catch: containerError,
      }),
    resize: (cols, rows) =>
      Effect.try({
        try: () => process.resize(cols, rows),
        catch: containerError,
      }),
  };
};

/**
 * @internal Adapt `ctx.container` to the Effect client. The container is
 * looked up on every call, never at construction: the client is also built
 * while planning a Worker, where no Durable Object state exists.
 */
export const fromContainer = (
  getContainer: () => cf.Container | undefined,
  /** The key of this Container's image in `ctx.container.images`. */
  imageKey?: string,
): ContainerClient => {
  const attached = Effect.suspend(() => {
    const container = getContainer();
    return container
      ? Effect.succeed(container)
      : Effect.fail(
          new ContainerError({ message: "No container is attached to this Durable Object." }),
        );
  });

  const call = <A>(f: (container: cf.Container) => A) =>
    Effect.flatMap(attached, (container) =>
      Effect.try({ try: () => f(container), catch: containerError }),
    );

  const callAsync = <A>(f: (container: cf.Container) => Promise<A>) =>
    Effect.flatMap(attached, (container) =>
      Effect.tryPromise({ try: () => f(container), catch: containerError }),
    );

  const running = call((container) => container.running ?? false);

  const ownImage = (container: cf.Container) =>
    imageKey === undefined ? undefined : container.images?.[imageKey];

  const image = Effect.flatMap(attached, (container) => {
    const ref = ownImage(container);
    return ref === undefined
      ? Effect.fail(
          new ContainerError({
            message: `Container '${imageKey}' publishes no image to this Durable Object.`,
          }),
        )
      : Effect.succeed(ref);
  });

  /** Default `image` to this Container's own image. */
  const withOwnImage = (
    container: cf.Container,
    options: ContainerStartupOptions | undefined,
  ): ContainerStartupOptions | undefined => {
    if (options?.image !== undefined || options?.containerSnapshot !== undefined) return options;
    const ref = ownImage(container);
    return ref === undefined ? options : ({ ...options, image: ref } as ContainerStartupOptions);
  };

  const start = (options?: ContainerStartupOptions) =>
    Effect.gen(function* () {
      const container = yield* attached;
      // Fast path: the steady state is one cheap `running` read, no lock.
      if (container.running) return;
      const { startMutex, readyPorts } = coordinationFor(container);
      yield* Semaphore.withPermits(
        startMutex,
        1,
      )(
        Effect.gen(function* () {
          // Re-check under the lock: a racing caller may have started it.
          if (container.running) return;
          // Nothing listens on a fresh start; re-probe every port.
          readyPorts.clear();
          yield* Effect.try({
            try: () => container.start(withOwnImage(container, options)),
            catch: classifyStartError,
          }).pipe(
            Effect.retry({
              while: (e) => e._tag === "ContainerRateLimitedError",
              schedule: Schedule.spaced(RATE_LIMIT_BACKOFF),
              times: RATE_LIMIT_RETRIES,
            }),
          );
          // Once the process exits (stopped, crashed, slept) its ports stop
          // listening: forget them so the next request re-probes.
          yield* Effect.forkDetach(
            Effect.tryPromise({ try: () => container.monitor(), catch: containerError }).pipe(
              Effect.ignore,
              Effect.ensuring(Effect.sync(() => readyPorts.clear())),
            ),
          );
        }),
      );
    }).pipe(
      Effect.retry({
        while: (e) => e._tag === "NoContainerInstanceError",
        schedule: Schedule.spaced(READINESS_POLL_INTERVAL),
        times: GET_CONTAINER_RETRIES,
      }),
    );

  // A single readiness probe: any response (even non-2xx) proves the port
  // accepts connections. A process that has exited is a crash, not "not ready".
  const probePort = (container: cf.Container, port: number) => {
    const notReady = (cause: unknown) =>
      container.running
        ? new ContainerError({ message: `Container port ${port} is not ready`, cause })
        : new ContainerCrashedError({
            message: `Container exited while waiting for port ${port}`,
            cause,
          });
    return Effect.tryPromise({
      try: () =>
        httpSchemePort(container.getTcpPort(port)).fetch("http://containerstarthealthcheck"),
      catch: notReady,
    }).pipe(
      Effect.timeout(READINESS_PROBE_TIMEOUT),
      Effect.asVoid,
      Effect.mapError((error) => (error._tag === "TimeoutError" ? notReady(error) : error)),
    );
  };

  const waitForPort = (port: number) =>
    Effect.gen(function* () {
      const container = yield* attached;
      const { readyPorts } = coordinationFor(container);
      if (readyPorts.has(port)) return container;
      if (!container.running) {
        return yield* new ContainerNotRunningError({
          message: `Container is not running; call start() before using port ${port}.`,
        });
      }
      yield* probePort(container, port).pipe(
        Effect.retry({
          while: (e) => e._tag === "ContainerError",
          schedule: Schedule.spaced(READINESS_POLL_INTERVAL),
          times: PORT_READY_RETRIES,
        }),
      );
      readyPorts.add(port);
      return container;
    });

  // The container is resolved per request, so a port can be taken while the
  // Durable Object is constructed, before the container starts.
  const getTcpPort = (port: number) =>
    Effect.succeed<ContainerPort>({
      // Wait for readiness (bounded), then send the real request once. Only a
      // not-yet-ready port or a transport blip is retried.
      fetch: ((request: HttpClientRequest.HttpClientRequest) =>
        waitForPort(port).pipe(
          // `fetch` accepts client and server requests alike.
          Effect.andThen((container) =>
            fromCloudflareFetcher(httpSchemePort(container.getTcpPort(port))).fetch(request),
          ),
          Effect.retry({
            while: (e: { _tag: string }) =>
              e._tag === "ContainerError" || e._tag === "HttpClientError",
            schedule: Schedule.spaced(READINESS_POLL_INTERVAL),
            times: REQUEST_RETRIES,
          }),
        )) as unknown as ContainerPort["fetch"],
      connect: (address, options) => {
        const container = getContainer();
        if (!container) throw new Error("No container is attached to this Durable Object.");
        return fromCloudflareFetcher(httpSchemePort(container.getTcpPort(port))).connect(
          address,
          options,
        );
      },
    });

  const startProcess = (cmd: string[], options?: ContainerExecOptions) =>
    Effect.flatMap(attached, (container) =>
      Effect.tryPromise({
        try: (interrupt) =>
          container.exec(cmd, {
            ...options,
            signal: combineSignals(interrupt, options?.signal),
          }),
        catch: containerError,
      }),
    ).pipe(Effect.map(fromProcess));

  return {
    image,
    running,
    start,
    destroy: (error) => callAsync((container) => container.destroy(error)),
    signal: (signo) => call((container) => container.signal(signo)),
    monitor: () =>
      Effect.flatMap(attached, (container) =>
        Effect.tryPromise({ try: () => container.monitor(), catch: classifyStartError }),
      ),
    inspect: () => callAsync((container) => container.inspect()),
    getTcpPort,
    exec: (cmd, options) =>
      Effect.acquireRelease(
        startProcess(cmd, options),
        // SIGKILL a process that is still running when its scope closes.
        (process) => Effect.ignore(process.kill(9)),
        { interruptible: true },
      ),
    snapshotContainer: (options = {}) =>
      callAsync((container) => container.snapshotContainer(options)),
    setInactivityTimeout: (durationMs) =>
      callAsync((container) => container.setInactivityTimeout(durationMs)),
    // workerd forwards intercepted requests over RPC and accepts only a
    // native Fetcher, which every Alchemy Fetcher carries as `raw`.
    interceptOutboundHttp: (addr, binding) =>
      callAsync((container) => container.interceptOutboundHttp(addr, binding.raw)),
    interceptAllOutboundHttp: (binding) =>
      callAsync((container) => container.interceptAllOutboundHttp(binding.raw)),
    interceptOutboundHttps: (addr, binding) =>
      callAsync((container) => container.interceptOutboundHttps(addr, binding.raw)),
  };
};

/**
 * @internal What `yield* Container` runs inside a Durable Object: register the
 * container's bindings, then return its handle. Methods declared on the
 * container's RPC shape are sent to its port-3000 server; the handle's own
 * methods take precedence.
 */
export const makeContainerHandle = Effect.fnUntraced(function* (
  id: string,
  binding: Effect.Effect<unknown, never, any>,
) {
  yield* binding;
  const state = yield* DurableObjectState;
  const client = fromContainer(() => state.container, id);
  const rpcPort = client.getTcpPort(3000);
  return makeFetchRpcStub<ContainerClient>({
    // RPC methods only run inside the Durable Object, where RuntimeContext is
    // always present; the stub's fetch type cannot carry it.
    fetch: (request) =>
      // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- erases RuntimeContext; RPC calls only run at runtime
      rpcPort.pipe(Effect.flatMap((port) => port.fetch(request))) as Effect.Effect<
        HttpClientResponse.HttpClientResponse,
        unknown
      >,
    baseUrl: "http://container",
    base: { ...client, "~alchemy/Id": id },
  });
});

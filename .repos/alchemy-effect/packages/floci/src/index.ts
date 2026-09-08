/**
 * `@alchemy.run/floci` — Effect-native manager for the
 * [floci](https://floci.io) local cloud emulator.
 *
 * alchemy's AWS local dev points its providers at a floci endpoint. This
 * package owns the emulator lifecycle with a strict resolution order that
 * keeps every local loop registry-free:
 *
 * 1. **Already serving** — if anything answers on the endpoint (e.g.
 *    `bun floci:dev` running `mvn quarkus:dev` from a floci checkout, or a
 *    hand-run container), it wins. Nothing is started, nothing owned.
 * 2. **`ALCHEMY_FLOCI_IMAGE`** — run a specific image (e.g. a locally
 *    built `floci:dev` from a patched fork).
 * 3. **The pinned release** — {@link DEFAULT_FLOCI_IMAGE}, alchemy's
 *    distribution of floci (upstream + alchemy patch set, published from
 *    github.com/alchemy-run/floci).
 *
 * The container is started detached with a stable name — the DOCKER DAEMON
 * is the supervisor, not alchemy: it outlives `alchemy dev` sessions, so
 * queues/tables/functions stay warm between runs and the next session
 * reattaches via the health probe in milliseconds.
 */
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The pinned floci release alchemy ships: upstream + the alchemy patch
 * set, built and published by the alchemy-run/floci fork's release
 * workflow. Bumping this pin (with a new `x.y.z-alchemy.N` tag) is how an
 * emulator change reaches users.
 */
export const DEFAULT_FLOCI_IMAGE = "ghcr.io/alchemy-run/floci:1.6.0-alchemy.9";

/** Default gateway port (LocalStack-compatible). */
export const DEFAULT_FLOCI_PORT = 4566;

/**
 * ELB listener ports published on the managed container. Floci's ELBv2
 * data plane serves each listener on the listener's OWN port inside the
 * container (see floci's ports doc) — its `*.elb.localhost.floci.io` DNS
 * resolves to 127.0.0.1, so the port must be published for the emulated
 * load balancer to be reachable from the host. Ports already taken on the
 * host are skipped (the gateway still works without them). A warning is
 * emitted only when the caller asked for those ports via
 * {@link FlociConfig.elbListenerPorts} — the default 80/443 publish is
 * opportunistic and a taken privileged port is the common case on a
 * developer machine, not a problem.
 */
export const DEFAULT_ELB_LISTENER_PORTS = [80, 443];

/**
 * Ports published for floci's emulated CloudFront edge. Each emulated
 * distribution is served on one of these as plain HTTP, so `alchemy dev`
 * hands out a `router.url` a browser can open — a distribution's
 * `*.cloudfront.net` domain resolves to nothing on a developer's machine.
 * The emulator assigns a port per distribution and reports it back; it can
 * only use ports the container actually published, so the resolved list is
 * passed in as `FLOCI_SERVICES_CLOUDFRONT_EDGE_PORTS`. Taken host ports are
 * skipped, exactly like the ELB listener ports above.
 */
export const DEFAULT_CLOUDFRONT_EDGE_PORTS = Array.from(
  { length: 20 },
  (_, index) => 9500 + index,
);

/** Default name of the managed container. */
export const DEFAULT_CONTAINER_NAME = "alchemy-floci";

/**
 * Stable host path of the emulator's self-signed CA bundle, refreshed by
 * {@link ensureFloci} on every successful health check (the CA is minted
 * inside the container, so it changes whenever the container is recreated).
 * Home-anchored (not cwd-relative) so every process in a dev session — test
 * runner, RPC sidecars, workerd children — resolves the same file; consumers
 * point TLS trust at it (e.g. `NODE_EXTRA_CA_CERTS`, which the local workerd
 * runtime folds into its outbound `trustedCertificates`).
 */
export const FLOCI_CA_PATH = path.join(os.homedir(), ".floci", "ca.pem");

/**
 * Host directory mounted at the container's TLS dir (`/app/data/tls`) so
 * the self-signed CA (which floci reuses when the files already exist)
 * SURVIVES container recreations. Without it, every recreate — an image
 * bump, a port-config change, a Docker daemon restart — mints a fresh CA,
 * and every process that loaded the previous bundle (workerd trust stores
 * read once at spawn) fails TLS against the emulator until restarted.
 */
export const FLOCI_TLS_DIR = path.join(os.homedir(), ".floci", "tls");

/**
 * Best-effort download of the emulator's CA bundle to {@link FLOCI_CA_PATH}.
 * Never fails the ensure: an emulator predating `/_floci/tls/ca` (or a
 * filesystem error) just leaves the previous bundle in place.
 */
const syncCaBundle = (endpoint: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(`${endpoint}/_floci/tls/ca`, { signal });
      if (!res.ok) return;
      const pem = await res.text();
      if (!pem.includes("BEGIN CERTIFICATE")) return;
      await fs.mkdir(path.dirname(FLOCI_CA_PATH), { recursive: true });
      await fs.writeFile(FLOCI_CA_PATH, pem);
      // Point local workerd (and any other child process spawned after this)
      // at the emulator CA so cross-cloud MicroVM data-plane TLS is trusted
      // under `alchemy dev` — Node reads NODE_EXTRA_CA_CERTS once at startup,
      // so setting it here (before local workers spawn during the apply) only
      // affects children, which is exactly the target. Never clobber a value
      // the caller set deliberately.
      if (process.env.NODE_EXTRA_CA_CERTS === undefined) {
        process.env.NODE_EXTRA_CA_CERTS = FLOCI_CA_PATH;
      }
    },
    catch: (cause) => new FlociError({ message: "ca sync failed", cause }),
  }).pipe(Effect.ignore);

export class FlociError extends Data.TaggedError("FlociError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface FlociConfig {
  /**
   * Image to run when the emulator is not already serving.
   * Resolution order: `ALCHEMY_FLOCI_IMAGE` env var, this field,
   * {@link DEFAULT_FLOCI_IMAGE}.
   */
  readonly image?: string | undefined;
  /**
   * Gateway port on the host.
   * @default 4566
   */
  readonly port?: number | undefined;
  /**
   * Name of the managed container (stable so `docker start` can revive a
   * stopped one).
   * @default "alchemy-floci"
   */
  readonly containerName?: string | undefined;
  /**
   * Host directory persisted into the container's data dir. Omit for
   * floci's default in-memory storage (state lives as long as the
   * container).
   */
  readonly storageDir?: string | undefined;
  /**
   * Mount the host Docker socket so floci's container-backed engines
   * (Lambda, ECS, EC2, RDS, ElastiCache) work.
   * @default true
   */
  readonly dockerSocket?: boolean | undefined;
  /**
   * Extra environment variables for the emulator (e.g.
   * `FLOCI_SERVICES_LAMBDA_HOT_RELOAD_ENABLED`).
   */
  readonly env?: Record<string, string> | undefined;
  /**
   * ELB listener ports to publish on the managed container (floci's ALB
   * data plane serves each listener on the listener's own port). Ports
   * already taken on the host are skipped (with a warning only when this
   * field is set — the default 80/443 publish is opportunistic).
   * @default [80, 443]
   */
  readonly elbListenerPorts?: readonly number[] | undefined;
  /**
   * Ports to publish for the emulated CloudFront edge (floci serves each
   * distribution on its own port). Ports already taken on the host are
   * skipped; an empty result turns the feature off in the emulator so it
   * never binds a port nothing can reach.
   * @default 9500-9519
   */
  readonly cloudfrontEdgePorts?: readonly number[] | undefined;
  /**
   * How long to wait for the emulator to become healthy after starting it
   * (first run includes the image pull).
   * @default 180 seconds
   */
  readonly readinessTimeout?: Duration.Input | undefined;
}

/** A running (or reused) emulator. */
export interface FlociInstance {
  /** Gateway endpoint, e.g. `http://localhost:4566`. */
  readonly endpoint: string;
  /**
   * Whether this manager started the container (`false` when something was
   * already serving on the endpoint — a dev-mode JVM, a hand-run
   * container, or a previous session's container).
   */
  readonly managed: boolean;
  /** Container name when {@link managed} is true. */
  readonly containerName?: string | undefined;
}

const docker = (args: ReadonlyArray<string>) =>
  Effect.callback<{ stdout: string; stderr: string }, FlociError>((resume) => {
    const child = execFile(
      "docker",
      args as Array<string>,
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              new FlociError({
                message: `docker ${args[0]} failed: ${stderr.trim() || error.message}`,
                cause: error,
              }),
            ),
          );
        } else {
          resume(Effect.succeed({ stdout, stderr }));
        }
      },
    );
    return Effect.sync(() => child.kill());
  });

/**
 * Whether anything answers HTTP on the endpoint. Any response — even an
 * error status — counts as serving; only a transport failure means down.
 */
export const isServing = (endpoint: string): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async (signal) => {
      await fetch(`${endpoint}/_floci/health`, { signal });
      return true;
    },
    catch: () => new FlociError({ message: "unreachable" }),
  }).pipe(Effect.orElseSucceed(() => false));

/** Fail unless `GET /_floci/health` answers 200. */
export const checkHealth = (
  endpoint: string,
): Effect.Effect<void, FlociError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(`${endpoint}/_floci/health`, { signal });
      if (!res.ok) {
        throw new Error(`health returned ${res.status}`);
      }
    },
    catch: (cause) =>
      new FlociError({
        message: `floci health check failed: ${String(cause)}`,
        cause,
      }),
  });

/** Resolve the image to run: env override, config, pinned default. */
export const resolveImage = (config?: FlociConfig): Effect.Effect<string> =>
  Effect.sync(
    () =>
      // `|| undefined`: an empty env var (`ALCHEMY_FLOCI_IMAGE= cmd`) means
      // "no override", not "run the image named ''" (an unrunnable docker ref).
      (process.env.ALCHEMY_FLOCI_IMAGE || undefined) ??
      config?.image ??
      DEFAULT_FLOCI_IMAGE,
  );

/** Whether a host TCP port is free (nothing is listening on it). */
const isHostPortFree = (port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES") {
        // Binding low ports (<1024) is privileged for THIS process, but
        // Docker's helper can still publish them — fall back to a
        // connect probe: a refused connection means nothing listens.
        const socket = net.connect({ port, host: "127.0.0.1" });
        socket.once("connect", () => {
          socket.destroy();
          resume(Effect.succeed(false));
        });
        socket.once("error", () => resume(Effect.succeed(true)));
        return;
      }
      resume(Effect.succeed(false));
    });
    server.once("listening", () =>
      server.close(() => resume(Effect.succeed(true))),
    );
    server.listen(port, "127.0.0.1");
    return Effect.sync(() => server.close());
  });

/**
 * The host ports the named container publishes, or `undefined` when the
 * container does not exist.
 */
const publishedPorts = (
  containerName: string,
): Effect.Effect<Set<number> | undefined> =>
  docker([
    "inspect",
    "--format",
    "{{json .HostConfig.PortBindings}}",
    containerName,
  ]).pipe(
    Effect.map(({ stdout }) => {
      let bindings: Record<string, Array<{ HostPort?: string }> | null> | null;
      try {
        bindings = JSON.parse(stdout.trim());
      } catch {
        // Racing a concurrent create/remove of the container can produce
        // partial output — treat it as "unknown", not a crash.
        return undefined;
      }
      const ports = new Set<number>();
      for (const spec of Object.values(bindings ?? {})) {
        for (const bind of spec ?? []) {
          const hostPort = Number(bind.HostPort);
          if (Number.isFinite(hostPort)) ports.add(hostPort);
        }
      }
      return ports;
    }),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * The requested ports the managed container should publish: every port that
 * is either already published by the container or still free on the host.
 * Taken ports are skipped (with a warning only when the caller asked for
 * them explicitly) so a busy host port never blocks the emulator from
 * starting.
 */
const resolvePublishablePorts = Effect.fn(function* (
  requested: readonly number[],
  published: ReadonlySet<number>,
  onTaken?: (port: number) => Effect.Effect<void>,
) {
  const desired: number[] = [];
  for (const port of requested) {
    if (published.has(port) || (yield* isHostPortFree(port))) {
      desired.push(port);
    } else if (onTaken !== undefined) {
      yield* onTaken(port);
    }
  }
  return desired;
});

/**
 * Ensure a floci emulator is serving and healthy, starting the managed
 * container if needed. Idempotent and cheap when already up (one HTTP
 * probe); see the module doc for the resolution order.
 */
/**
 * One `ensureFloci` at a time per process. Callers memoize per stack
 * build, but separate builds (concurrent tests, parallel dev commands) can
 * ensure at the same moment: when the managed container needs recreating,
 * two callers would both `docker rm -f` it ("removal of container … is
 * already in progress") and then race `docker run` on the name. Under the
 * mutex the second caller observes the container the first one started.
 */
const ensureMutex = Semaphore.makeUnsafe(1);

export const ensureFloci = (
  config?: FlociConfig,
): Effect.Effect<FlociInstance, FlociError> =>
  ensureMutex.withPermits(1)(
    // The mutex serializes ensures within THIS process; across processes
    // (a test runner and a dev CLI booting together) the recreate path can
    // still race — one process's `rm -f` can delete the container the
    // other just created, and the loser's `docker run` fails (sometimes
    // with an empty stderr). Re-running the whole ensure converges: the
    // retry re-observes whatever the winner left serving and reuses it.
    ensureFlociUnsynchronized(config).pipe(
      Effect.retry({
        schedule: Schedule.spaced("2 seconds"),
        times: 3,
      }),
    ),
  );

const ensureFlociUnsynchronized = (
  config?: FlociConfig,
): Effect.Effect<FlociInstance, FlociError> =>
  Effect.gen(function* () {
    const port = config?.port ?? DEFAULT_FLOCI_PORT;
    const endpoint = `http://localhost:${port}`;
    const containerName = config?.containerName ?? DEFAULT_CONTAINER_NAME;
    const published = yield* publishedPorts(containerName);
    const elbPorts = yield* resolvePublishablePorts(
      config?.elbListenerPorts ?? DEFAULT_ELB_LISTENER_PORTS,
      published ?? new Set(),
      // Default 80/443 are opportunistic (most stacks have no ELB). A taken
      // privileged port is the common case on a developer machine, not a
      // problem — warn only when the caller asked for those ports.
      config?.elbListenerPorts === undefined
        ? undefined
        : (port) =>
            Effect.logWarning(
              `floci: host port ${port} is taken — emulated load balancer listeners on ${port} will not be reachable from the host`,
            ),
    );
    const edgePorts = yield* resolvePublishablePorts(
      config?.cloudfrontEdgePorts ?? DEFAULT_CLOUDFRONT_EDGE_PORTS,
      published ?? new Set(),
    );

    // Converge the managed container's EXPLICITLY-requested ports and its
    // image: a container missing ports the caller configured can't serve
    // them, and one running a superseded emulator image (a floci release
    // bump, or a switch of `ALCHEMY_FLOCI_IMAGE`) would silently miss
    // emulator features the providers now rely on — so either is recreated
    // (emulated state is ephemeral by design; the next apply reconciles
    // it). The OPPORTUNISTIC defaults (80/443, the CloudFront edge range)
    // deliberately do NOT trigger recreation: which of them resolve as
    // publishable depends on what happens to be free in the observing
    // process, so keying recreation on them makes concurrent consumers
    // (a test run and a dev CLI) recreate each other's container forever.
    // An UNMANAGED server (a dev-mode JVM, a hand-run container) is never
    // touched. To keep running a hand-built image under the managed name,
    // keep `ALCHEMY_FLOCI_IMAGE` set — the resolution order is the
    // contract.
    const publishPorts = [...elbPorts, ...edgePorts];
    const requiredPorts = [
      ...(config?.elbListenerPorts ?? []).filter((p) => elbPorts.includes(p)),
      ...(config?.cloudfrontEdgePorts ?? []).filter((p) =>
        edgePorts.includes(p),
      ),
    ];
    const image = yield* resolveImage(config);
    const runningImage =
      published !== undefined
        ? yield* docker([
            "inspect",
            "--format",
            "{{.Config.Image}}",
            containerName,
          ]).pipe(
            Effect.map(({ stdout }) => stdout.trim() || undefined),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
    const needsRecreate =
      published !== undefined &&
      (requiredPorts.some((p) => !published.has(p)) ||
        (runningImage !== undefined && runningImage !== image));

    if (yield* isServing(endpoint)) {
      if (!needsRecreate) {
        // Something may be serving but still starting — the readiness
        // poll tolerates transient unhealthiness.
        yield* checkHealth(endpoint).pipe(
          Effect.catch(() => waitForHealth(endpoint, config)),
        );
        yield* syncCaBundle(endpoint);
        return { endpoint, managed: false };
      }
      // Only recreate when the server IS our managed container (otherwise
      // removing the container would not free the endpoint anyway).
      yield* Effect.logInfo(
        `floci: recreating ${containerName} (image ${runningImage} -> ${image}, ports [${publishPorts.join(", ")}])`,
      );
      yield* docker(["rm", "-f", containerName]);
    } else if (needsRecreate) {
      yield* Effect.logInfo(
        `floci: recreating ${containerName} (image ${runningImage} -> ${image}, ports [${publishPorts.join(", ")}])`,
      );
      yield* docker(["rm", "-f", containerName]);
    } else {
      // Revive a stopped container from a previous session, else run fresh.
      const started = yield* docker(["start", containerName]).pipe(
        Effect.map(() => true),
        Effect.orElseSucceed(() => false),
      );
      if (started) {
        yield* waitForHealth(endpoint, config);
        yield* syncCaBundle(endpoint);
        return { endpoint, managed: true, containerName };
      }
    }

    yield* Effect.tryPromise({
      try: () => fs.mkdir(FLOCI_TLS_DIR, { recursive: true }),
      catch: (cause) => new FlociError({ message: "tls dir", cause }),
    }).pipe(Effect.ignore);
    const args = [
      "run",
      "-d",
      "--name",
      containerName,
      "-p",
      `${port}:4566`,
      // Docker Desktop injects `host.docker.internal` automatically; native
      // Linux Docker does not. The emulator needs it to reach a dev server
      // running on the developer's machine (a CloudFront origin pointed at
      // `localhost:<port>`, for one).
      "--add-host",
      "host.docker.internal:host-gateway",
      ...publishPorts.flatMap((p) => ["-p", `${p}:${p}`]),
      // The emulator can only hand a distribution a port the container
      // published, so it gets the resolved list rather than its own default
      // range — and the feature is switched off outright when nothing could
      // be published, so it never binds a port nothing can reach.
      "-e",
      edgePorts.length > 0
        ? `FLOCI_SERVICES_CLOUDFRONT_EDGE_PORTS=${edgePorts.join(",")}`
        : "FLOCI_SERVICES_CLOUDFRONT_EDGE_PORTS_ENABLED=false",
      ...(config?.dockerSocket === false
        ? []
        : ["-v", "/var/run/docker.sock:/var/run/docker.sock", "-u", "root"]),
      ...(config?.storageDir !== undefined
        ? [
            "-v",
            `${config.storageDir}:/app/data`,
            "-e",
            "FLOCI_STORAGE_MODE=hybrid",
          ]
        : // No full storage mount: still persist the TLS dir so the
          // self-signed CA is stable across container recreations (floci
          // reuses existing cert files).
          ["-v", `${FLOCI_TLS_DIR}:/app/data/tls`]),
      ...Object.entries(config?.env ?? {}).flatMap(([key, value]) => [
        "-e",
        `${key}=${value}`,
      ]),
      image,
    ];
    yield* docker(args).pipe(
      // A concurrent ensureFloci (e.g. the dev sidecar racing the CLI's
      // exec child on a machine where floci is not yet running) may have
      // created the container between our checks and this run. Docker
      // reports that as a name conflict — but not reliably: the losing
      // `docker run` has been observed exiting non-zero with an EMPTY
      // stderr right after a Docker Desktop restart, so the error text
      // cannot be trusted. Ask Docker whether the container exists now and
      // reuse it if so; only a run that left nothing behind is a failure.
      Effect.catch((error) =>
        docker(["inspect", "--format", "{{.Id}}", containerName]).pipe(
          Effect.flatMap(({ stdout }) =>
            stdout.trim() ? Effect.void : Effect.fail(error),
          ),
          Effect.catch(() => Effect.fail(error)),
        ),
      ),
    );

    yield* waitForHealth(endpoint, config);
    yield* syncCaBundle(endpoint);
    return { endpoint, managed: true, containerName };
  });

const waitForHealth = (endpoint: string, config?: FlociConfig) =>
  checkHealth(endpoint).pipe(
    Effect.retry({
      schedule: Schedule.spaced("1 second"),
      times: Math.max(
        1,
        Math.ceil(
          Duration.toSeconds(
            // 300s: a freshly (re)started Docker daemon can take minutes to
            // create the first container from the 1.3GB image; giving up
            // early parks `alchemy dev` on a FlociError until the next file
            // edit, which reads as a wedge.
            Duration.fromInputUnsafe(config?.readinessTimeout ?? "300 seconds"),
          ),
        ),
      ),
    }),
    Effect.mapError(
      (error) =>
        new FlociError({
          message:
            `floci did not become healthy at ${endpoint}: ${error.message}. ` +
            "Check `docker logs " +
            (config?.containerName ?? DEFAULT_CONTAINER_NAME) +
            "`.",
          cause: error,
        }),
    ),
  );

/** Stop (not remove) the managed container. */
export const stopFloci = (
  containerName: string = DEFAULT_CONTAINER_NAME,
): Effect.Effect<void, FlociError> =>
  Effect.asVoid(docker(["stop", containerName]));

/** Remove the managed container (and its in-memory state). */
export const destroyFloci = (
  containerName: string = DEFAULT_CONTAINER_NAME,
): Effect.Effect<void, FlociError> =>
  Effect.asVoid(docker(["rm", "-f", containerName]));

/** Tail of the managed container's logs. */
export const flociLogs = (
  containerName: string = DEFAULT_CONTAINER_NAME,
  lines = 200,
): Effect.Effect<string, FlociError> =>
  Effect.map(
    docker(["logs", "--tail", String(lines), containerName]),
    ({ stdout, stderr }) => stdout + stderr,
  );

import { execFile } from "node:child_process";
import * as Floci from "@alchemy.run/aws/Local/Floci";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
/**
 * Lifecycle tests for `ensureFloci`, the manager that owns the floci
 * emulator container.
 *
 * Runs against the real Docker daemon. The bugs this suite pins are Docker
 * behaviors (a `docker start` that no-ops on a running-but-unbound
 * container, a run that leaves nothing published), so a mocked `docker`
 * would only encode assumptions.
 *
 * Every case gets its own container name and gateway port and publishes no
 * opportunistic ELB/CloudFront edge ports, so the suite never touches the
 * shared `alchemy-floci` container or competes with it for host ports.
 */

const docker = (args: ReadonlyArray<string>) =>
  Effect.callback<string, Error>((resume) => {
    const child = execFile("docker", args as Array<string>, (error, stdout, stderr) =>
      resume(
        error
          ? Effect.fail(new Error(`docker ${args.join(" ")}: ${stderr.trim() || error.message}`))
          : Effect.succeed(stdout.trim()),
      ),
    );
    return Effect.sync(() => child.kill());
  });

const containerId = (name: string) => docker(["inspect", "--format", "{{.Id}}", name]);

const isRunning = (name: string) =>
  docker(["inspect", "--format", "{{.State.Running}}", name]).pipe(
    Effect.map((out) => out === "true"),
    Effect.orElseSucceed(() => false),
  );

/**
 * A config for an isolated test container: its own name and gateway port,
 * no ELB/CloudFront edge ports. `external: false` keeps the suite on the
 * managed-container path even when the runner exports
 * `ALCHEMY_FLOCI_EXTERNAL=1` for the shared gateway.
 */
const isolated = (name: string, port: number, overrides?: Floci.FlociConfig) =>
  Effect.gen(function* () {
    const containerName = `floci-lifecycle-${name}`;
    yield* Floci.destroyFloci(containerName).pipe(Effect.ignore);
    yield* Effect.addFinalizer(() => Floci.destroyFloci(containerName).pipe(Effect.ignore));
    return {
      external: false,
      containerName,
      port,
      elbListenerPorts: [],
      cloudfrontEdgePorts: [],
      readinessTimeout: "90 seconds",
      ...overrides,
    } satisfies Floci.FlociConfig;
  });

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = yield* Effect.sync(() => Date.now());
    const value = yield* effect;
    const elapsed = (yield* Effect.sync(() => Date.now())) - start;
    return { value, elapsed };
  });

/**
 * Publish `port` from a throwaway container for the scope. Docker refuses
 * to publish it again ("port is already allocated") on every platform,
 * while the manager's host-side probe may or may not see it (it does behind
 * Linux's docker-proxy, it doesn't on Docker Desktop) — the probe-invisible
 * conflict #2214 reported for rootless Docker and Tailscale listeners.
 */
const holdPort = (name: string, port: number) =>
  Effect.acquireRelease(
    docker(["rm", "-f", name]).pipe(
      Effect.ignore,
      Effect.andThen(
        docker(["run", "-d", "--name", name, "-p", `${port}:${port}`, Floci.DEFAULT_FLOCI_IMAGE]),
      ),
    ),
    () => docker(["rm", "-f", name]).pipe(Effect.ignore),
  );

describe.sequential("FlociLifecycle", { tags: ["provider:aws", "local"] }, () => {
  it.live(
    "starts a fresh container and publishes the gateway",
    () =>
      Effect.gen(function* () {
        const config = yield* isolated("fresh", 4591);

        const instance = yield* Floci.ensureFloci(config);

        expect(instance).toEqual({
          endpoint: "http://localhost:4591",
          managed: true,
          containerName: config.containerName,
        });
        expect(yield* docker(["port", config.containerName, "4566/tcp"])).toContain(":4591");
        yield* Floci.checkHealth(instance.endpoint);
      }),
    { timeout: 180_000 },
  );

  it.live(
    "reattaches to a serving container without recreating it",
    () =>
      Effect.gen(function* () {
        const config = yield* isolated("reattach", 4592);
        yield* Floci.ensureFloci(config);
        const id = yield* containerId(config.containerName);

        const { value: instance, elapsed } = yield* timed(Floci.ensureFloci(config));

        expect(instance.endpoint).toBe("http://localhost:4592");
        expect(yield* containerId(config.containerName)).toBe(id);
        expect(elapsed).toBeLessThan(2_000);
      }),
    { timeout: 180_000 },
  );

  it.live(
    "revives a stopped container",
    () =>
      Effect.gen(function* () {
        const config = yield* isolated("revive", 4593);
        yield* Floci.ensureFloci(config);
        const id = yield* containerId(config.containerName);
        yield* Floci.stopFloci(config.containerName);
        expect(yield* isRunning(config.containerName)).toBe(false);

        const instance = yield* Floci.ensureFloci(config);

        expect(instance.managed).toBe(true);
        expect(yield* containerId(config.containerName)).toBe(id);
        yield* Floci.checkHealth(instance.endpoint);
      }),
    { timeout: 180_000 },
  );

  // #2214: a failed port setup left the container RUNNING with nothing
  // published. `docker start` on it is a no-op success, so the manager
  // reused it and polled an unreachable endpoint for the whole readiness
  // timeout (300s × 4 attempts by default).
  it.live(
    "replaces a running container whose gateway is not published",
    () =>
      Effect.gen(function* () {
        const config = yield* isolated("unbound", 4594);
        const image = yield* Floci.resolveImage(config);
        yield* docker(["run", "-d", "--name", config.containerName, image]);
        const staleId = yield* containerId(config.containerName);

        const { value: instance, elapsed } = yield* timed(Floci.ensureFloci(config));

        expect(instance.managed).toBe(true);
        expect(yield* containerId(config.containerName)).not.toBe(staleId);
        expect(yield* docker(["port", config.containerName, "4566/tcp"])).toContain(":4594");
        // Far below the 90s readiness timeout the old code waited out.
        expect(elapsed).toBeLessThan(60_000);
      }),
    { timeout: 180_000 },
  );

  // #2214: a port Docker refuses to publish (rootless Docker and 80/443, a
  // port held elsewhere) must be dropped, not leave an unreachable
  // container behind — and the dropped port must not make every later
  // ensure recreate (and wipe) the container.
  it.live(
    "starts without a port Docker cannot publish, and keeps the container",
    () =>
      Effect.gen(function* () {
        yield* holdPort("floci-lifecycle-holder", 9595);
        const config = yield* isolated("conflict", 4595, { elbListenerPorts: [9595] });

        const { value: instance, elapsed } = yield* timed(Floci.ensureFloci(config));

        expect(instance.managed).toBe(true);
        const ports = yield* docker(["port", config.containerName]);
        expect(ports).toContain(":4595");
        expect(ports).not.toContain("9595");
        // A fast fallback, not a readiness timeout (90s here).
        expect(elapsed).toBeLessThan(60_000);
        yield* Floci.checkHealth(instance.endpoint);

        const id = yield* containerId(config.containerName);
        yield* Floci.ensureFloci(config);
        expect(yield* containerId(config.containerName)).toBe(id);
      }),
    { timeout: 180_000 },
  );

  it.live(
    "recreates the container when the requested ports change",
    () =>
      Effect.gen(function* () {
        const config = yield* isolated("ports", 4598);
        yield* Floci.ensureFloci(config);
        const id = yield* containerId(config.containerName);

        yield* Floci.ensureFloci({ ...config, elbListenerPorts: [9598] });

        expect(yield* containerId(config.containerName)).not.toBe(id);
        expect(yield* docker(["port", config.containerName])).toContain(":9598");
      }),
    { timeout: 180_000 },
  );

  it.live.skipIf(!!process.env.ALCHEMY_FLOCI_IMAGE)(
    "recreates the container when the image changes",
    () =>
      Effect.gen(function* () {
        const alias = "alchemy-floci-lifecycle:drift";
        const config = yield* isolated("drift", 4596);
        yield* Floci.ensureFloci(config);
        const id = yield* containerId(config.containerName);
        // A local tag of the same image: a different reference without a pull.
        yield* docker(["tag", Floci.DEFAULT_FLOCI_IMAGE, alias]);
        yield* Effect.addFinalizer(() => docker(["rmi", alias]).pipe(Effect.ignore));

        yield* Floci.ensureFloci({ ...config, image: alias });

        expect(yield* containerId(config.containerName)).not.toBe(id);
        expect(
          yield* docker(["inspect", "--format", "{{.Config.Image}}", config.containerName]),
        ).toBe(alias);
      }),
    { timeout: 180_000 },
  );

  it.live(
    "converges concurrent ensures onto one container",
    () =>
      Effect.gen(function* () {
        const config = yield* isolated("concurrent", 4597);

        const [a, b] = yield* Effect.all([Floci.ensureFloci(config), Floci.ensureFloci(config)], {
          concurrency: 2,
        });

        expect(a.endpoint).toBe(b.endpoint);
        const ids = yield* docker([
          "ps",
          "-a",
          "--filter",
          `name=^${config.containerName}$`,
          "--format",
          "{{.ID}}",
        ]);
        expect(ids.split("\n").filter(Boolean)).toHaveLength(1);
        yield* Floci.checkHealth(a.endpoint);
      }),
    { timeout: 180_000 },
  );
});

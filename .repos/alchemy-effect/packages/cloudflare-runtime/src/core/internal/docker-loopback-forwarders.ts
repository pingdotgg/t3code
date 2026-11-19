import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  CONTAINER_LOOPBACK_MOUNT,
  loopbackSocketDir,
  usesUnixSocketLoopback,
} from "../DockerLoopback.ts";
import { SystemError } from "../RuntimeError.shared.ts";

const failure = (message: string, cause?: unknown) =>
  SystemError.make({ subtag: "DockerLoopbackForwarder", message, cause });

/**
 * Docker joins a helper to each networking sidecar's namespace; the runtime
 * scope owns the helpers. workerd addresses containers by name, so the
 * sidecar name from the Docker API path is the key.
 */
export const makeDockerLoopbackForwarders = Effect.fnUntraced(function* (options: {
  bin: string;
  socketPath: string;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const lock = yield* Semaphore.make(1);
  const forwards = yield* FiberMap.make<string, void>();
  const attachedPorts = new Map<string, string>();

  const docker = (args: string[]) =>
    spawner.spawn(
      ChildProcess.make(options.bin, ["--host", options.socketPath, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGKILL",
      }),
    );

  const forward = (name: string, ports: number[], ready: Deferred.Deferred<void, SystemError>) =>
    Effect.gen(function* () {
      const helper = `alchemy-loopback-${crypto.randomUUID()}`;
      // Registered before spawn: stopping the CLI does not remove its container.
      yield* Effect.addFinalizer(() =>
        docker(["rm", "--force", helper]).pipe(
          Effect.flatMap((child) => child.exitCode),
          Effect.scoped,
          Effect.timeout("10 seconds"),
          Effect.ignore,
        ),
      );
      const child = yield* docker([
        "run",
        "--rm",
        "--init",
        "--name",
        helper,
        "--label",
        `alchemy.loopback.target=${name}`,
        "--network",
        `container:${name}`,
        "--mount",
        `type=bind,source=${loopbackSocketDir()},target=${CONTAINER_LOOPBACK_MOUNT},readonly`,
        "--entrypoint",
        "node",
        "node:22-alpine",
        `${CONTAINER_LOOPBACK_MOUNT}/forward.mjs`,
        CONTAINER_LOOPBACK_MOUNT,
        ...ports.map(String),
      ]);
      let errors = "";
      const [exitCode] = yield* Effect.all(
        [
          child.exitCode,
          child.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.runForEach((line) =>
              line === "ALCHEMY_LOOPBACK_READY" ? Deferred.succeed(ready, undefined) : Effect.void,
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText,
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                errors = (errors + chunk).slice(-4096);
              }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return yield* failure(
        `Loopback forwarder for ${name} exited (${exitCode}): ${errors.trim()}`,
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        Schema.is(SystemError)(cause) ? cause : failure(String(cause), cause),
      ),
      Effect.catchCause((cause) =>
        // A completed readiness signal means this is a failure after startup.
        Effect.flatMap(Deferred.failCause(ready, cause), (failedStartup) =>
          failedStartup || Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(cause),
        ),
      ),
    );

  const detach = (name: string) =>
    Effect.suspend(() => {
      attachedPorts.delete(name);
      return FiberMap.remove(forwards, name);
    });

  const attach = Effect.fnUntraced(function* (name: string, ports: readonly number[]) {
    if (!usesUnixSocketLoopback() || ports.length === 0 || !name.endsWith("-proxy")) return;
    if (forwards.state._tag === "Closed") {
      return yield* failure("Docker loopback forwarding is closed");
    }
    const unique = [...new Set(ports)].sort((a, b) => a - b);
    // attach holds the permit until readiness, so a running helper is ready.
    if (attachedPorts.get(name) === unique.join(",") && (yield* FiberMap.has(forwards, name))) {
      return;
    }
    const ready = yield* Deferred.make<void, SystemError>();
    // FiberMap.run interrupts a replaced fiber without awaiting its finalizers;
    // remove the previous helper first so its ports are released.
    yield* detach(name);
    yield* FiberMap.run(forwards, name, forward(name, unique, ready));
    yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () =>
          Effect.fail(
            failure(`Loopback forwarder for ${name} did not become ready within 60 seconds`),
          ),
      }),
      Effect.onError(() => detach(name)),
    );
    attachedPorts.set(name, unique.join(","));
  });

  return {
    attach: (name: string, ports: readonly number[]) => lock.withPermit(attach(name, ports)),
    detach: (name: string) => lock.withPermit(detach(name)),
  };
});

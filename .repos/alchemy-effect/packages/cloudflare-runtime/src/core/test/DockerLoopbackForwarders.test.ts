import * as http from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import {
  closeLoopbackUnixSockets,
  ensureLoopbackUnixSockets,
  usesUnixSocketLoopback,
} from "../DockerLoopback.ts";
import { makeDockerLoopbackForwarders } from "../internal/docker-loopback-forwarders.ts";
import { listenOnLoopback } from "../internal/listen-on-loopback.ts";

const bin = process.env.DOCKER_BIN ?? "docker";
const docker = Effect.fnUntraced(
  function* (...args: string[]) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(bin, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGKILL",
      }),
    );
    const result = yield* Effect.all(
      {
        exitCode: child.exitCode,
        stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
        stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
      },
      { concurrency: "unbounded" },
    );
    if (result.exitCode !== 0) return yield* Effect.fail(new Error(result.stderr));
    return result.stdout.trim();
  },
  Effect.scoped,
  Effect.timeout("20 seconds"),
);

const setup = Effect.gen(function* () {
  const endpoint =
    process.env.DOCKER_HOST ??
    (yield* docker("context", "inspect", "--format", "{{.Endpoints.docker.Host}}"));
  const name = `alchemy-loopback-test-${crypto.randomUUID()}-proxy`;
  yield* Effect.acquireRelease(
    docker(
      "run",
      "--rm",
      "--detach",
      "--name",
      name,
      "node:22-alpine",
      "node",
      "-e",
      "setInterval(() => {}, 1000)",
    ),
    () => docker("rm", "--force", name).pipe(Effect.orDie),
  );
  yield* Effect.addFinalizer(() => Effect.sync(closeLoopbackUnixSockets));
  return {
    name,
    endpoint,
    helpers: docker("ps", "--all", "--quiet", "--filter", `label=alchemy.loopback.target=${name}`),
  };
});

const hostPort = Effect.suspend(() =>
  listenOnLoopback(http.createServer((_req, res) => res.end("host-loopback"))),
);

describe.skipIf(!usesUnixSocketLoopback())("Docker loopback forwarders", () => {
  it.live(
    "waits for listeners, forwards host traffic and removes helpers on detach and scope close",
    () =>
      Effect.gen(function* () {
        const { name, endpoint, helpers } = yield* setup;
        const port = yield* hostPort;
        ensureLoopbackUnixSockets([port]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* makeDockerLoopbackForwarders({ bin, socketPath: endpoint });
            yield* Effect.all([manager.attach(name, [port]), manager.attach(name, [port])], {
              concurrency: "unbounded",
            });
            const helper = yield* helpers;
            expect(helper).not.toBe("");
            expect(helper.split("\n")).toHaveLength(1);
            yield* manager.attach(name, [port]);
            expect(yield* helpers).toBe(helper);
            const response = yield* docker(
              "exec",
              name,
              "node",
              "-e",
              `fetch("http://127.0.0.1:${port}").then(r => r.text()).then(console.log)`,
            );
            expect(response).toBe("host-loopback");
            const secondPort = yield* hostPort;
            ensureLoopbackUnixSockets([secondPort]);
            yield* manager.attach(name, [port, secondPort]);
            const replacement = yield* helpers;
            expect(replacement).not.toBe(helper);
            expect(replacement.split("\n")).toHaveLength(1);
            expect(
              yield* docker(
                "exec",
                name,
                "node",
                "-e",
                `fetch("http://127.0.0.1:${secondPort}").then(r => r.text()).then(console.log)`,
              ),
            ).toBe("host-loopback");
            yield* manager.detach(name);
            expect(yield* helpers).toBe("");
            yield* manager.attach(name, [port]);
          }),
        );
        expect(yield* helpers).toBe("");
      }).pipe(Effect.provide(NodeServices.layer)),
    90_000,
  );

  it.live(
    "reports listener startup errors and removes the failed helper",
    () =>
      Effect.gen(function* () {
        const { name, endpoint, helpers } = yield* setup;
        const manager = yield* makeDockerLoopbackForwarders({ bin, socketPath: endpoint });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const listener = yield* spawner.spawn(
          ChildProcess.make(
            bin,
            [
              "exec",
              name,
              "node",
              "-e",
              'require("node:net").createServer().listen(54321, "127.0.0.1", () => console.log("ready"))',
            ],
            { stdout: "pipe", killSignal: "SIGKILL" },
          ),
        );
        yield* listener.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runHead,
          Effect.timeout("10 seconds"),
        );
        ensureLoopbackUnixSockets([54321]);
        const result = yield* Effect.result(manager.attach(name, [54321]));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("SystemError");
          expect(result.failure.message).toContain("EADDRINUSE");
        }
        expect(yield* helpers).toBe("");
      }).pipe(Effect.provide(NodeServices.layer)),
    90_000,
  );
});

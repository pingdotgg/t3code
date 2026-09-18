import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  buildFailureHint,
  CONTAINER_LOOPBACK_ALIAS,
  Docker,
  DockerLive,
  mergeContainerCreateEnv,
  rewriteLoopbackHosts,
  toPullRef,
} from "../Docker.ts";

const PINNED =
  "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8";
const PINNED_WITHOUT_TAG =
  "cloudflare/proxy-everything@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8";

describe("Docker", () => {
  describe("toPullRef", () => {
    it("drops the tag when a digest pins the image", () => {
      expect(toPullRef(PINNED)).toBe(PINNED_WITHOUT_TAG);
    });

    it("keeps tag-only refs unchanged", () => {
      expect(toPullRef("rocicorp/zero:1.8.0")).toBe("rocicorp/zero:1.8.0");
    });

    it("keeps digest-only refs unchanged", () => {
      expect(toPullRef("repo@sha256:abc")).toBe("repo@sha256:abc");
    });

    it("preserves registry ports", () => {
      expect(toPullRef("registry.example.com:5000/repo:v1@sha256:abc")).toBe(
        "registry.example.com:5000/repo@sha256:abc",
      );
    });
  });

  describe("rewriteLoopbackHosts", () => {
    it("keeps the alias localhost-looking (Prisma's http/https gate)", () => {
      expect(CONTAINER_LOOPBACK_ALIAS).toContain("localhost");
    });

    it("rewrites URL hosts for every loopback form", () => {
      expect(rewriteLoopbackHosts("http://localhost:3000/path?q=1")).toBe(
        `http://${CONTAINER_LOOPBACK_ALIAS}:3000/path?q=1`,
      );
      expect(
        rewriteLoopbackHosts("postgres://user:pass@127.0.0.1:5432/db"),
      ).toBe(`postgres://user:pass@${CONTAINER_LOOPBACK_ALIAS}:5432/db`);
      expect(rewriteLoopbackHosts("http://0.0.0.0:8080")).toBe(
        `http://${CONTAINER_LOOPBACK_ALIAS}:8080`,
      );
      expect(rewriteLoopbackHosts("http://[::1]:8080")).toBe(
        `http://${CONTAINER_LOOPBACK_ALIAS}:8080`,
      );
    });

    it("rewrites the local Prisma Postgres URL but not the api_key payload", () => {
      const apiKey = "eyJkYXRhYmFzZVVybCI6InBvc3RncmVzOi8vbG9jYWxob3N0In0";
      expect(
        rewriteLoopbackHosts(
          `prisma+postgres://localhost:51216/?api_key=${apiKey}`,
        ),
      ).toBe(
        `prisma+postgres://${CONTAINER_LOOPBACK_ALIAS}:51216/?api_key=${apiKey}`,
      );
    });

    it("rewrites every common connection-string shape, not just Prisma's", () => {
      expect(rewriteLoopbackHosts("mysql://root@127.0.0.1:3306/app")).toBe(
        `mysql://root@${CONTAINER_LOOPBACK_ALIAS}:3306/app`,
      );
      expect(rewriteLoopbackHosts("redis://localhost:6379/0")).toBe(
        `redis://${CONTAINER_LOOPBACK_ALIAS}:6379/0`,
      );
      expect(rewriteLoopbackHosts("amqp://guest:guest@localhost:5672")).toBe(
        `amqp://guest:guest@${CONTAINER_LOOPBACK_ALIAS}:5672`,
      );
      // multi-host URI (every host is rewritten)
      expect(
        rewriteLoopbackHosts(
          "mongodb://user:pass@localhost:27017,localhost:27018/db?replicaSet=rs0",
        ),
      ).toBe(
        `mongodb://user:pass@${CONTAINER_LOOPBACK_ALIAS}:27017,${CONTAINER_LOOPBACK_ALIAS}:27018/db?replicaSet=rs0`,
      );
      // JDBC-style compound scheme
      expect(rewriteLoopbackHosts("jdbc:postgresql://localhost:5432/db")).toBe(
        `jdbc:postgresql://${CONTAINER_LOOPBACK_ALIAS}:5432/db`,
      );
      // Kafka-style broker list
      expect(rewriteLoopbackHosts("localhost:9092,localhost:9093")).toBe(
        `${CONTAINER_LOOPBACK_ALIAS}:9092,${CONTAINER_LOOPBACK_ALIAS}:9093`,
      );
      // websocket + URL embedded in a JSON env value
      expect(rewriteLoopbackHosts('{"ws":"ws://localhost:8080/socket"}')).toBe(
        `{"ws":"ws://${CONTAINER_LOOPBACK_ALIAS}:8080/socket"}`,
      );
    });

    it("rewrites bare host values and DSN keyword form", () => {
      expect(rewriteLoopbackHosts("localhost:5432")).toBe(
        `${CONTAINER_LOOPBACK_ALIAS}:5432`,
      );
      expect(rewriteLoopbackHosts("localhost")).toBe(CONTAINER_LOOPBACK_ALIAS);
      expect(
        rewriteLoopbackHosts("host=127.0.0.1 port=5432 sslmode=disable"),
      ).toBe(`host=${CONTAINER_LOOPBACK_ALIAS} port=5432 sslmode=disable`);
    });

    it("leaves non-loopback hosts and lookalike substrings alone", () => {
      expect(rewriteLoopbackHosts("https://db.example.com:5432")).toBe(
        "https://db.example.com:5432",
      );
      expect(rewriteLoopbackHosts("http://localhost.example.com/")).toBe(
        "http://localhost.example.com/",
      );
      expect(rewriteLoopbackHosts("http://notlocalhost:3000")).toBe(
        "http://notlocalhost:3000",
      );
      expect(rewriteLoopbackHosts("8080")).toBe("8080");
    });

    it("leaves Neon and PlanetScale cloud URLs untouched", () => {
      const neon =
        "postgres://neondb_owner:secret@ep-cool-name-123456-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";
      const neonDirect =
        "postgresql://neondb_owner:secret@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
      const planetscalePg =
        "postgresql://user:secret@xxxx.pg.psdb.cloud:6432/postgres?sslmode=verify-full";
      const planetscaleMysql =
        "mysql://user:secret@aws.connect.psdb.cloud:3306/db?sslaccept=strict";
      expect(rewriteLoopbackHosts(neon)).toBe(neon);
      expect(rewriteLoopbackHosts(neonDirect)).toBe(neonDirect);
      expect(rewriteLoopbackHosts(planetscalePg)).toBe(planetscalePg);
      expect(rewriteLoopbackHosts(planetscaleMysql)).toBe(planetscaleMysql);
      expect(
        mergeContainerCreateEnv(["DATABASE_URL=" + neon], {
          DATABASE_URL: neon,
        }),
      ).toEqual([`DATABASE_URL=${neon}`]);
    });
  });

  describe("mergeContainerCreateEnv", () => {
    it("rewrites and replaces by name instead of appending a second value", () => {
      expect(
        mergeContainerCreateEnv(
          [
            "PATH=/usr/bin",
            "DATABASE_URL=postgres://postgres@127.0.0.1:5432/db",
          ],
          {
            DATABASE_URL: "postgres://postgres@127.0.0.1:5432/db",
            PPG_URL: "prisma+postgres://localhost:51216/?api_key=test",
          },
        ),
      ).toEqual([
        "PATH=/usr/bin",
        `DATABASE_URL=postgres://postgres@${CONTAINER_LOOPBACK_ALIAS}:5432/db`,
        `PPG_URL=prisma+postgres://${CONTAINER_LOOPBACK_ALIAS}:51216/?api_key=test`,
      ]);
    });

    it("rewrites loopback hosts already present on the create body", () => {
      expect(
        mergeContainerCreateEnv(
          ["DATABASE_URL=postgres://postgres@127.0.0.1:5432/db"],
          undefined,
        ),
      ).toEqual([
        `DATABASE_URL=postgres://postgres@${CONTAINER_LOOPBACK_ALIAS}:5432/db`,
      ]);
    });

    it("preserves flag-style entries that have no value", () => {
      expect(
        mergeContainerCreateEnv(["DEBUG", "FOO=bar"], { FOO: "baz" }),
      ).toEqual(["DEBUG", "FOO=baz"]);
    });
  });
});

/** Records every spawned argv and pretends each command exited 0 with no output. */
const spawned: Array<ReadonlyArray<string>> = [];
const SpawnerStub = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make((command) => {
    if (command._tag === "StandardCommand") {
      spawned.push([command.command, ...command.args]);
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  }),
);

layer(Layer.provide(DockerLive, Layer.merge(NodeServices.layer, SpawnerStub)))(
  (it) => {
    it.effect("pull strips the tag from digest-pinned refs", () =>
      Effect.gen(function* () {
        spawned.length = 0;
        const docker = yield* Docker;
        yield* docker.pull("alchemy-test:latest", { imageUri: PINNED });
        expect(spawned).toContainEqual([
          "docker",
          "pull",
          PINNED_WITHOUT_TAG,
          "--platform",
          "linux/amd64",
        ]);
        // only the pull ref is rewritten — the local tag alias keeps the original uri
        expect(spawned).toContainEqual([
          "docker",
          "tag",
          PINNED,
          "alchemy-test:latest",
        ]);
      }),
    );

    it.effect("pull passes refs without a digest through unchanged", () =>
      Effect.gen(function* () {
        spawned.length = 0;
        const docker = yield* Docker;
        yield* docker.pull("alchemy-test:latest", {
          imageUri: "rocicorp/zero:1.8.0",
        });
        expect(spawned).toContainEqual([
          "docker",
          "pull",
          "rocicorp/zero:1.8.0",
          "--platform",
          "linux/amd64",
        ]);
      }),
    );
  },
);

/**
 * A stub whose `docker image inspect` stdout is configurable per test, so
 * `getWorkerdDockerConfiguration`'s inspect-before-pull check on the egress
 * interceptor image can be exercised both ways (present vs absent locally).
 * All other commands (`docker pull`, `docker tag`, …) still succeed with
 * empty output, matching `SpawnerStub` above.
 *
 * `getWorkerdDockerConfiguration`'s pull/skip-pull decision runs on a
 * `forkDetach` fiber that starts as soon as the `Docker` layer is built —
 * i.e. before an `it.effect` body gets a chance to run, let alone reset a
 * shared recording array. So each test below gets its OWN dedicated
 * `spawned` array (returned alongside the layer) instead of resetting the
 * top-level one mid-test, which would race the fiber's own spawns.
 */
const makeInspectStub = (inspectStdout: string) => {
  const spawned: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand") {
        spawned.push([command.command, ...command.args]);
      }
      const isInspect =
        command._tag === "StandardCommand" &&
        command.args[0] === "image" &&
        command.args[1] === "inspect";
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(
            ChildProcessSpawner.ExitCode(
              isInspect && inspectStdout === "" ? 1 : 0,
            ),
          ),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: isInspect
            ? Stream.make(new TextEncoder().encode(inspectStdout))
            : Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      );
    }),
  );
  return { layer, spawned };
};

const present = makeInspectStub("sha256:deadbeef");
layer(
  Layer.provide(DockerLive, Layer.merge(NodeServices.layer, present.layer)),
)((it) => {
  it.effect(
    "skips the pull when the interceptor image is already present locally",
    () =>
      Effect.gen(function* () {
        const docker = yield* Docker;
        yield* docker.getWorkerdDockerConfiguration;
        expect(present.spawned).toContainEqual([
          "docker",
          "image",
          "inspect",
          PINNED,
          "--format",
          "{{.Id}}",
        ]);
        expect(present.spawned.filter(([, verb]) => verb === "pull")).toEqual(
          [],
        );
      }),
  );
});

const absent = makeInspectStub("");
layer(Layer.provide(DockerLive, Layer.merge(NodeServices.layer, absent.layer)))(
  (it) => {
    it.effect(
      "pulls the interceptor image when it is not present locally",
      () =>
        Effect.gen(function* () {
          const docker = yield* Docker;
          yield* docker.getWorkerdDockerConfiguration;
          expect(absent.spawned).toContainEqual([
            "docker",
            "image",
            "inspect",
            PINNED,
            "--format",
            "{{.Id}}",
          ]);
          // Exactly one pull, with no `--platform`: the interceptor is a
          // host-side sidecar, so Docker must resolve the host-native variant
          // of this multi-arch image. Forcing `linux/amd64` here runs it
          // under emulation on arm64 hosts, where it exits 1 with
          // `setsockoptint: protocol not available` before workerd can create
          // the user container.
          expect(absent.spawned.filter(([, verb]) => verb === "pull")).toEqual([
            ["docker", "pull", PINNED_WITHOUT_TAG],
          ]);
        }),
    );
  },
);

/**
 * Spawner whose `docker <verb>` exits non-zero with `stderr`, so the tests
 * below can assert that a failing docker command is reported rather than
 * mistaken for a successful one.
 */
const makeFailingStub = (verb: string, stderr: string, exitCode = 1) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const fails =
        command._tag === "StandardCommand" && command.args[0] === verb;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(
            ChildProcessSpawner.ExitCode(fails ? exitCode : 0),
          ),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: fails
            ? Stream.make(new TextEncoder().encode(stderr))
            : Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      );
    }),
  );

describe("buildFailureHint", () => {
  it("names the buildx plugin when docker only names the flag", () => {
    expect(buildFailureHint("unknown flag: --load")).toContain("buildx");
  });

  it("stays silent for ordinary build failures", () => {
    expect(
      buildFailureHint("ERROR: failed to solve: dockerfile parse error"),
    ).toBeUndefined();
  });
});

/**
 * `run` reports a non-zero exit in its success channel, so a command whose
 * failure matters has to check it. When `build` did not, a failed
 * `docker build` looked like a success: no image was ever created and the
 * only symptom was workerd looping on `Container exited while waiting for
 * port 8080`, with the actual docker error absent from the logs entirely.
 */
layer(
  Layer.provide(
    DockerLive,
    Layer.merge(
      NodeServices.layer,
      makeFailingStub("build", "unknown flag: --load"),
    ),
  ),
)((it) => {
  it.effect("build fails when docker build exits non-zero", () =>
    Effect.gen(function* () {
      const docker = yield* Docker;
      const result = yield* Effect.result(
        docker.build("alchemy-test:latest", {
          dockerfile: `${import.meta.dirname}/fixtures/Dockerfile.build-failure`,
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      const error = result.failure as {
        subtag: string;
        hint?: string;
        detail?: { exitCode: number; stderr: string };
      };
      expect(error.subtag).toBe("DockerBuildFailed");
      // The docker output the user needs is carried, not discarded.
      expect(error.detail?.exitCode).toBe(1);
      expect(error.detail?.stderr).toContain("unknown flag: --load");
      expect(error.hint).toContain("buildx");
    }),
  );
});

layer(
  Layer.provide(
    DockerLive,
    Layer.merge(
      NodeServices.layer,
      makeFailingStub("tag", "Error response from daemon: no such image"),
    ),
  ),
)((it) => {
  it.effect("pull fails when the follow-up docker tag exits non-zero", () =>
    Effect.gen(function* () {
      const docker = yield* Docker;
      const result = yield* Effect.result(
        docker.pull("alchemy-test:latest", { imageUri: PINNED }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      const error = result.failure as {
        subtag: string;
        detail?: { stderr: string };
      };
      expect(error.subtag).toBe("DockerTagFailed");
      expect(error.detail?.stderr).toContain("no such image");
    }),
  );
});

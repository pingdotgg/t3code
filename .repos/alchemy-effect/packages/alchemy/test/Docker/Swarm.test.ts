import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Docker from "@/Docker";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
});

// Docker.Swarm mutates engine-level state (swarm membership), so these tests
// never touch the host engine. Each test boots a disposable docker:dind
// engine, points a Docker.Context at it, and provisions the swarm there —
// the exact remote-VPS flow, on a throwaway daemon.
const startDind = Effect.fn(function* (name: string, port: number) {
  const docker = yield* Docker.Docker;
  const host = `tcp://127.0.0.1:${port}`;

  yield* Effect.addFinalizer(() =>
    docker.run(["rm", "-f", name]).pipe(Effect.ignore),
  );
  yield* docker.run(["rm", "-f", name]).pipe(Effect.ignore);
  yield* docker.run([
    "run",
    "-d",
    "--rm",
    "--privileged",
    "--name",
    name,
    "-e",
    "DOCKER_TLS_CERTDIR=",
    "-p",
    `127.0.0.1:${port}:2375`,
    "docker:dind",
  ]);

  // The inner daemon takes a few seconds to boot before it serves the API.
  yield* docker
    .run(["-H", host, "info", "--format", "{{.ServerVersion}}"])
    .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }));

  return { host };
});

describe("Docker.Swarm", { concurrent: false }, () => {
  test.provider.skipIf(!!process.env.FAST)(
    "initializes a swarm on a fresh engine and deploys a service into it",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const { host } = yield* startDind("alchemy-test-dind-swarm", 23750);

        const program = Effect.gen(function* () {
          const context = yield* Docker.Context("dind-context", {
            name: "alchemy-test-dind-swarm-ctx",
            docker: `host=${host}`,
          });
          const swarm = yield* Docker.Swarm("swarm", {
            context,
            advertiseAddr: "127.0.0.1",
          });
          const service = yield* Docker.Service("web", {
            context: swarm,
            image: "nginx:alpine",
            replicas: 1,
          });
          return { swarm, service };
        });

        const { swarm, service } = yield* stack.deploy(program);

        expect(swarm.id.length).toBeGreaterThan(0);
        expect(swarm.nodeId.length).toBeGreaterThan(0);
        expect(swarm.context).toBe("alchemy-test-dind-swarm-ctx");
        expect(swarm.managers).toBe(1);
        expect(swarm.nodes).toBe(1);
        // The service inherited the swarm's context and landed on the dind
        // engine, ordered after the swarm init.
        expect(service.context).toBe("alchemy-test-dind-swarm-ctx");
        expect(service.replicas).toBe(1);

        // Idempotent: a second deploy converges on the same cluster.
        const again = yield* stack.deploy(program);
        expect(again.swarm.id).toBe(swarm.id);
        expect(again.service.id).toBe(service.id);

        yield* stack.destroy();

        // Destroy dissolved the swarm (service first, then leave) and
        // removed the context.
        const state = yield* docker.run([
          "-H",
          host,
          "info",
          "--format",
          "{{.Swarm.LocalNodeState}}",
        ]);
        expect(state.stdout).toBe("inactive");
        const contextGone = yield* docker.context
          .inspect("alchemy-test-dind-swarm-ctx")
          .pipe(
            Effect.map(() => false),
            Effect.catchReason("PlatformError", "NotFound", () =>
              Effect.succeed(true),
            ),
          );
        expect(contextGone).toBe(true);
      }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!!process.env.FAST)(
    "refuses an already-initialized engine unless explicitly adopted",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const { host } = yield* startDind("alchemy-test-dind-adopt", 23751);

        // The engine is already a swarm manager — initialized out of band,
        // reachable through an out-of-band context. The Swarm resource's
        // props must be fully resolved (a plain context name, not a
        // same-plan Context resource) for the engine's adoption probe to
        // run at plan time.
        yield* docker.run([
          "-H",
          host,
          "swarm",
          "init",
          "--advertise-addr",
          "127.0.0.1",
        ]);
        const contextName = "alchemy-test-dind-adopt-ctx";
        yield* Effect.addFinalizer(() =>
          docker.context.remove(contextName, true).pipe(Effect.ignore),
        );
        yield* docker.context.remove(contextName, true).pipe(Effect.ignore);
        yield* docker.context.create({
          name: contextName,
          docker: `host=${host}`,
        });

        const makeSwarm = (adopted: boolean) =>
          Effect.gen(function* () {
            const swarm = Docker.Swarm("existing-swarm", {
              context: contextName,
            });
            return yield* adopted ? swarm.pipe(adopt(true)) : swarm;
          });

        const error = yield* stack.deploy(makeSwarm(false)).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
        expect(error).toBeInstanceOf(OwnedBySomeoneElse);

        const adopted = yield* stack.deploy(makeSwarm(true));
        expect(adopted.id.length).toBeGreaterThan(0);
        expect(adopted.nodeId.length).toBeGreaterThan(0);

        yield* stack.destroy();
      }),
    { timeout: 300_000 },
  );
});

const findOwnedError = (
  cause: Cause.Cause<unknown>,
): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is OwnedBySomeoneElse =>
        value instanceof OwnedBySomeoneElse,
    );

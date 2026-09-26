import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Docker from "@/Docker";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { ensureDockerSwarm } from "./Runtime.ts";

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
});

// Every test deploys real swarm services through the engine (plan → apply →
// destroy) — no provider-method unit tests. The suite self-provisions a
// single-node swarm on the local engine (`ensureDockerSwarm`), so it runs
// anywhere Docker runs; deactivate afterwards with `docker swarm leave
// --force` if you don't want the node to stay a swarm manager.
describe("Docker.Service", { concurrent: false }, () => {
  test.provider(
    "creates a replicated service with labels",
    (stack) =>
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        const serviceName = "alchemy-test-service-create";
        const service = yield* stack.deploy(
          Docker.Service("created-service", {
            name: serviceName,
            image: "nginx:alpine",
            replicas: 1,
            labels: { "com.alchemy.test": "true" },
          }),
        );

        expect(service.name).toBe(serviceName);
        expect(service.id.length).toBeGreaterThan(0);
        expect(service.image).toContain("nginx:alpine");
        expect(service.replicas).toBe(1);
        expect(service.endpointMode).toBe("vip");
        expect(service.labels["com.alchemy.test"]).toBe("true");

        yield* stack.destroy();

        const docker = yield* Docker.Docker;
        const gone = yield* docker.service.inspect(service.id).pipe(
          Effect.map(() => false),
          Effect.catchReason("PlatformError", "NotFound", () =>
            Effect.succeed(true),
          ),
        );
        expect(gone).toBe(true);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "replaces a service when replicas change",
    (stack) =>
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        const serviceName = "alchemy-test-service-replicas";

        const first = yield* stack.deploy(
          Docker.Service("scaled-service", {
            name: serviceName,
            image: "nginx:alpine",
            replicas: 1,
          }),
        );
        expect(first.replicas).toBe(1);

        const second = yield* stack.deploy(
          Docker.Service("scaled-service", {
            name: serviceName,
            image: "nginx:alpine",
            replicas: 2,
          }),
        );

        expect(second.id).not.toBe(first.id);
        expect(second.replicas).toBe(2);

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "replaces a service when its Docker context changes",
    (stack) =>
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        const serviceName = "alchemy-test-service-context";

        const first = yield* stack.deploy(
          Docker.Service("context-service", {
            name: serviceName,
            image: "nginx:alpine",
          }),
        );
        expect(first.context).toBeUndefined();

        // `default` is the engine's built-in context — same daemon, but a
        // different context ref, so the replace path (delete-first, recreate
        // under `--context`) runs against a real named context.
        const second = yield* stack.deploy(
          Docker.Service("context-service", {
            name: serviceName,
            image: "nginx:alpine",
            context: "default",
          }),
        );

        expect(second.id).not.toBe(first.id);
        expect(second.context).toBe("default");

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "refuses a pre-existing service unless explicitly adopted",
    (stack) =>
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        const docker = yield* Docker.Docker;
        const serviceName = "alchemy-test-service-adopt-existing";

        yield* Effect.addFinalizer(() =>
          docker.service.remove(serviceName).pipe(Effect.ignore),
        );

        yield* docker.service
          .remove(serviceName)
          .pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          );

        yield* docker.service.create({
          name: serviceName,
          image: "nginx:alpine",
          replicas: 1,
        });

        const error = yield* stack
          .deploy(
            Docker.Service("existing-service", {
              name: serviceName,
              image: "nginx:alpine",
              replicas: 1,
            }),
          )
          .pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
          );

        expect(error).toBeInstanceOf(OwnedBySomeoneElse);

        const adopted = yield* stack.deploy(
          Docker.Service("existing-service", {
            name: serviceName,
            image: "nginx:alpine",
            replicas: 1,
          }).pipe(adopt(true)),
        );

        expect(adopted.name).toBe(serviceName);
        expect(adopted.id.length).toBeGreaterThan(0);

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "replaces a service when labels change",
    (stack) =>
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        const serviceName = "alchemy-test-service-replace";

        const first = yield* stack.deploy(
          Docker.Service("replaceable-service", {
            name: serviceName,
            image: "nginx:alpine",
            labels: { generation: "1" },
          }),
        );

        const second = yield* stack.deploy(
          Docker.Service("replaceable-service", {
            name: serviceName,
            image: "nginx:alpine",
            labels: { generation: "2" },
          }),
        );

        expect(second.id).not.toBe(first.id);
        expect(second.labels.generation).toBe("2");

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
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

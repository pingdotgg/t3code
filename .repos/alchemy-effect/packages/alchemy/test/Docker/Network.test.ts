import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Docker from "@/Docker";
import * as Provider from "@/Provider";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { isDockerReady } from "./Runtime.ts";

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
});

test.provider("diff replaces a network when labels change", () =>
  Effect.gen(function* () {
    const networkProvider = yield* Provider.findProvider(Docker.Network);
    const networkDiff = yield* networkProvider.diff!({
      id: "app",
      fqn: "app",
      instanceId: "instance",
      olds: { name: "app", labels: { usage: "old" } },
      news: { name: "app", labels: { usage: "new" } },
      oldBindings: [],
      newBindings: [],
      output: {
        id: "app",
        name: "app",
        driver: "bridge",
        enableIPv6: false,
        labels: { usage: "old" },
        createdAt: 0,
      },
    });
    expect(networkDiff).toEqual({ action: "replace", deleteFirst: true });
  }),
);

describe("Docker.Network", { concurrent: false }, () => {
  test.provider.skipIf(!isDockerReady)("creates a bridge network", (stack) =>
    Effect.gen(function* () {
      const network = yield* stack.deploy(
        Docker.Network("created-network", {
          labels: { "com.alchemy.test": "true" },
        }),
      );
      expect(network).toMatchObject({
        name: expect.any(String),
        driver: "bridge",
        id: expect.any(String),
        labels: { "com.alchemy.test": "true" },
      });
    }),
  );

  test.provider.skipIf(!isDockerReady)(
    "refuses a pre-existing network unless explicitly adopted",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const networkName = "alchemy-test-network-adoption";
        yield* Effect.addFinalizer(() =>
          docker.network.remove(networkName).pipe(Effect.ignore),
        );
        yield* docker.network
          .remove(networkName)
          .pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          );
        yield* docker.network.create({ name: networkName, driver: "bridge" });

        const error = yield* stack
          .deploy(Docker.Network("existing-network", { name: networkName }))
          .pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
          );
        expect(error).toBeInstanceOf(OwnedBySomeoneElse);

        const network = yield* stack.deploy(
          Docker.Network("existing-network", { name: networkName }).pipe(
            adopt(true),
          ),
        );
        expect(network.name).toBe(networkName);
        expect(network.id.length).toBeGreaterThan(0);
      }),
  );

  test.provider.skipIf(!isDockerReady)(
    "adopts an existing same-name network with stack adoption",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const networkName = "alchemy-test-network-adopt-existing";
        yield* Effect.addFinalizer(() =>
          docker.network.remove(networkName).pipe(Effect.ignore),
        );
        yield* docker.network
          .remove(networkName)
          .pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          );
        yield* docker.network.create({ name: networkName, driver: "bridge" });

        const network = yield* stack.deploy(
          Docker.Network("existing-network", {
            name: networkName,
            driver: "bridge",
          }).pipe(adopt(true)),
        );
        expect(network.name).toBe(networkName);
        expect(network.id.length).toBeGreaterThan(0);
      }),
  );

  test.provider.skipIf(!isDockerReady)(
    "replaces a network when its labels change",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = "alchemy-test-network-replace";
        yield* docker.network
          .remove(name)
          .pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          );
        const first = yield* stack.deploy(
          Docker.Network("replaceable-network", {
            name,
            labels: { generation: "1" },
          }),
        );
        const second = yield* stack.deploy(
          Docker.Network("replaceable-network", {
            name,
            labels: { generation: "2" },
          }),
        );
        expect(second.id).not.toBe(first.id);
        expect(second.labels.generation).toBe("2");
      }),
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

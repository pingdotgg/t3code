import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy.ts";
import * as Docker from "@/Docker";
import * as Provider from "@/Provider";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { isDockerReady } from "./Runtime.ts";

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
});

test.provider("diff replaces a volume when labels change", () =>
  Effect.gen(function* () {
    const volumeProvider = yield* Provider.findProvider(Docker.Volume);
    const volumeDiff = yield* volumeProvider.diff!({
      id: "data",
      fqn: "data",
      instanceId: "instance",
      olds: { name: "data", labels: { usage: "old" } },
      news: { name: "data", labels: { usage: "new" } },
      oldBindings: [],
      newBindings: [],
      output: {
        id: "data",
        name: "data",
        driver: "local",
        driverOpts: {},
        labels: { usage: "old" },
        mountpoint: undefined,
        createdAt: 0,
      },
    });
    expect(volumeDiff).toEqual({ action: "replace", deleteFirst: true });
  }),
);

describe("Docker.Volume", { concurrent: false }, () => {
  test.provider.skipIf(!isDockerReady)(
    "creates a volume with labels",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const volumeName = "alchemy-test-volume-create";
        yield* Effect.addFinalizer(() =>
          docker.volume.remove(volumeName).pipe(Effect.ignore),
        );
        const volume = yield* stack.deploy(
          Docker.Volume("created-volume", {
            name: volumeName,
            labels: { "com.alchemy.test": "true" },
          }),
        );
        expect(volume.name).toBe(volumeName);
        expect(volume.id).toBe(volumeName);
        expect(volume.driver).toBe("local");
        expect(volume.labels["com.alchemy.test"]).toBe("true");
        expect(volume.mountpoint?.length).toBeGreaterThan(0);
      }),
  );

  test.provider.skipIf(!isDockerReady)(
    "adopts an existing Docker volume",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const volumeName = "alchemy-test-volume-adopt-existing";
        yield* Effect.addFinalizer(() =>
          docker.volume.remove(volumeName).pipe(Effect.ignore),
        );
        yield* docker.volume
          .remove(volumeName)
          .pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          );
        yield* docker.volume.create({ name: volumeName });

        const error = yield* stack
          .deploy(Docker.Volume("existing-volume", { name: volumeName }))
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(OwnedBySomeoneElse);
        const volume = yield* stack.deploy(
          Docker.Volume("existing-volume", { name: volumeName }).pipe(
            adopt(true),
          ),
        );
        expect(volume.name).toBe(volumeName);
        expect(volume.id).toBe(volumeName);
        expect(volume.driver).toBe("local");
      }),
  );

  test.provider.skipIf(!isDockerReady)(
    "replaces a volume when its labels change",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const volumeName = "alchemy-test-volume-replace";
        yield* docker.volume
          .remove(volumeName)
          .pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          );
        const first = yield* stack.deploy(
          Docker.Volume("replaceable-volume", {
            labels: { generation: "1" },
          }),
        );
        const second = yield* stack.deploy(
          Docker.Volume("replaceable-volume", {
            labels: { generation: "2" },
          }),
        );
        expect(second.id).not.toBe(first.id);
        expect(second.labels.generation).toBe("2");
      }),
  );
});

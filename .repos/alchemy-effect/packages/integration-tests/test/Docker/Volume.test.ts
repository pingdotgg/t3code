import * as Docker from "@alchemy.run/docker";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Docker.providers(), state: inMemoryState() });

test.provider(
  "diff replaces a volume when labels change",
  () =>
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
  { tags: ["provider:docker", "provider:docker:volume", "local"] },
);

test.provider(
  "diff replaces a volume when its Docker context changes",
  () =>
    Effect.gen(function* () {
      const volumeProvider = yield* Provider.findProvider(Docker.Volume);
      const volumeDiff = yield* volumeProvider.diff!({
        id: "data",
        fqn: "data",
        instanceId: "instance",
        olds: { name: "data", context: "default" },
        news: { name: "data", context: "remote-build" },
        oldBindings: [],
        newBindings: [],
        output: {
          id: "data",
          name: "data",
          driver: "local",
          driverOpts: {},
          labels: {},
          mountpoint: undefined,
          createdAt: 0,
        },
      });
      expect(volumeDiff).toEqual({ action: "replace", deleteFirst: true });
    }),
  { tags: ["provider:docker", "provider:docker:volume", "local"] },
);

describe(
  "Docker.Volume",
  { tags: ["provider:docker", "provider:docker:volume", "local"], concurrent: false },
  () => {
    // Every prop is optional: `Docker.Volume("data")` must plan, deploy,
    // redeploy in place, and destroy without a props object.
    test.provider("deploys a volume declared without props", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        yield* stack.destroy();
        const first = yield* stack.deploy(Docker.Volume("bare-volume"));
        expect(first.driver).toBe("local");
        const second = yield* stack.deploy(Docker.Volume("bare-volume"));
        expect(second.createdAt).toBe(first.createdAt);
        yield* stack.destroy();
        const gone = yield* docker.volume.inspect(first.name).pipe(Effect.flip);
        expect(gone.reason._tag).toBe("NotFound");
      }),
    );

    test.provider("creates a volume with labels", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const volumeName = "alchemy-test-volume-create";
        yield* Effect.addFinalizer(() => docker.volume.remove(volumeName).pipe(Effect.ignore));
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

    test.provider("adopts an existing Docker volume", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const volumeName = "alchemy-test-volume-adopt-existing";
        yield* Effect.addFinalizer(() => docker.volume.remove(volumeName).pipe(Effect.ignore));
        yield* docker.volume
          .remove(volumeName)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
        yield* docker.volume.create({ name: volumeName });

        const error = yield* stack
          .deploy(Docker.Volume("existing-volume", { name: volumeName }))
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(OwnedBySomeoneElse);
        const volume = yield* stack.deploy(
          Docker.Volume("existing-volume", { name: volumeName }).pipe(adopt(true)),
        );
        expect(volume.name).toBe(volumeName);
        expect(volume.id).toBe(volumeName);
        expect(volume.driver).toBe("local");
      }),
    );

    test.provider("replaces a volume when its labels change", (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const volumeName = "alchemy-test-volume-replace";
        yield* docker.volume
          .remove(volumeName)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
        const first = yield* stack.deploy(
          Docker.Volume("replaceable-volume", { labels: { generation: "1" } }),
        );
        const second = yield* stack.deploy(
          Docker.Volume("replaceable-volume", { labels: { generation: "2" } }),
        );
        expect(second.id).not.toBe(first.id);
        expect(second.labels.generation).toBe("2");
      }),
    );
  },
);

import * as Docker from "@/Docker";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
});

describe("Docker.Image", { concurrent: false }, () => {
  test.provider("plans an update when the Docker context changes", (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-context-plan-",
      });
      yield* fs.writeFileString(
        path.join(root, "Dockerfile"),
        "FROM scratch\n",
      );

      const base = Docker.Image("context-image", {
        tag: "latest",
        context: "default",
        build: { context: root },
      });
      const changed = Docker.Image("context-image", {
        tag: "latest",
        context: "remote-build",
        build: { context: root },
      });

      yield* stack.deploy(base);
      const plan = yield* stack.plan(changed);
      expect(plan.resources["context-image"]).toMatchObject({
        action: "update",
      });
    }),
  );

  test.provider(
    "builds a tiny Dockerfile with an auto-generated name",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-docker-image-",
        });
        yield* fs.writeFileString(
          path.join(root, "Dockerfile"),
          "FROM scratch\nLABEL alchemy.test=true\n",
        );
        // No explicit name: the engine auto-generates the physical name.
        const image = yield* stack.deploy(
          Docker.Image("tiny-image", {
            tag: "latest",
            build: { context: root },
          }),
        );
        expect(image.imageRef.endsWith(":latest")).toBe(true);
        expect(image.imageId.length).toBeGreaterThan(0);
      }),
  );

  test.provider("updates when the build context changes", (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-canary-",
      });
      yield* fs.writeFileString(
        path.join(root, "Dockerfile"),
        "FROM scratch\n",
      );
      yield* fs.writeFileString(
        path.join(root, "Dockerfile"),
        "FROM scratch\nLABEL alchemy.test=1\n",
      );

      const makeStack = Docker.Image("tiny-image", {
        tag: "latest",
        build: { context: root },
      });

      yield* stack.deploy(makeStack);
      const plan1 = yield* stack.plan(makeStack);
      expect(plan1.resources["tiny-image"]).toMatchObject({ action: "noop" });
      yield* fs.writeFileString(
        path.join(root, "Dockerfile"),
        "FROM scratch\nLABEL alchemy.test=2\n",
      );
      const plan2 = yield* stack.plan(makeStack);
      expect(plan2.resources["tiny-image"]).toMatchObject({ action: "update" });
    }),
  );

  test.provider("builds with an explicit repository name and tag", (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-image-named-",
      });
      yield* fs.writeFileString(
        path.join(root, "Dockerfile"),
        "FROM scratch\nLABEL alchemy.test=named\n",
      );
      const image = yield* stack.deploy(
        Docker.Image("named-image", {
          name: "alchemy-test-named",
          tag: "v1",
          build: { context: root },
        }),
      );
      expect(image.name).toBe("alchemy-test-named");
      expect(image.imageRef).toBe("alchemy-test-named:v1");
      expect(image.tag).toBe("v1");
    }),
  );

  test.provider("rebuilds when the build context changes", (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-image-rebuild-",
      });
      const dockerfile = path.join(root, "Dockerfile");

      yield* fs.writeFileString(dockerfile, "FROM scratch\nLABEL gen=1\n");
      const first = yield* stack.deploy(
        Docker.Image("rebuilt-image", {
          tag: "latest",
          build: { context: root },
        }),
      );

      yield* fs.writeFileString(dockerfile, "FROM scratch\nLABEL gen=2\n");
      const second = yield* stack.deploy(
        Docker.Image("rebuilt-image", {
          tag: "latest",
          build: { context: root },
        }),
      );

      expect(second.imageRef).toBe(first.imageRef);
    }),
  );
});

import { Docker, DockerLive } from "@/Docker";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { spawnSync } from "node:child_process";

const isDockerReady =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

const describe = layer(Layer.provideMerge(DockerLive, NodeServices.layer));

describe("Docker.materialize", (it) => {
  it.effect("materializes a Dockerfile in the target directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-ctx-",
      });
      const ctx = path.join(root, "ctx");
      yield* docker.materialize({
        context: ctx,
        dockerfile: "FROM scratch\n",
        files: [],
      });
      const dockerfile = path.join(ctx, "Dockerfile");
      expect(yield* fs.exists(dockerfile)).toBe(true);
      expect(yield* fs.readFileString(dockerfile)).toBe("FROM scratch\n");
    }),
  );

  it.effect("writes nested context files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-path-",
      });
      const ctx = path.join(root, "ctx");
      yield* docker.materialize({
        context: ctx,
        dockerfile: "FROM scratch\n",
        files: [{ path: "nested/hello.txt", content: "hi" }],
      });
      expect(
        yield* fs.readFileString(path.join(ctx, "nested", "hello.txt")),
      ).toBe("hi");
    }),
  );
});

describe("Docker.image", (it) => {
  it.effect.skipIf(!isDockerReady)(
    "builds a minimal image with content Dockerfile",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const docker = yield* Docker;
        const tag = "alchemy-docker-test:minimal";
        yield* Effect.addFinalizer(() =>
          docker.image.remove(tag, true).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
            Effect.ignore,
          ),
        );
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-docker-build-",
        });
        const ctx = path.join(root, "ctx");
        yield* docker.materialize({
          context: ctx,
          dockerfile: [
            "FROM alpine:3.19",
            "RUN echo ok > /tmp/ok.txt",
            'CMD ["cat", "/tmp/ok.txt"]',
            "",
          ].join("\n"),
          files: [],
        });
        yield* docker.image.build({ tag, context: ctx });
        const inspect = yield* docker.image.inspect(tag);
        expect(inspect.Id.length).toBeGreaterThan(0);
      }),
  );

  it.effect.skipIf(!isDockerReady)("passes --platform and --build-arg", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;
      const tag = "alchemy-docker-test:args";
      yield* Effect.addFinalizer(() =>
        docker.image.remove(tag, true).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          Effect.ignore,
        ),
      );
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-build-",
      });
      const ctx = path.join(root, "ctx");
      yield* docker.materialize({
        context: ctx,
        dockerfile: [
          "FROM alpine:3.19",
          "ARG FOO=default",
          'RUN echo "$FOO" > /out.txt',
          "",
        ].join("\n"),
        files: [],
      });
      yield* docker.image.build({
        tag,
        context: ctx,
        platform: "linux/amd64",
        "build-arg": { FOO: "from-arg" },
      });
      const out = yield* docker.run(["run", "--rm", tag, "cat", "/out.txt"]);
      expect(out.stdout.trim()).toBe("from-arg");
    }),
  );

  it.effect.skipIf(!isDockerReady)("respects multi-stage --target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;
      const tag = "alchemy-docker-test:target";
      yield* Effect.addFinalizer(() =>
        docker.image.remove(tag, true).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
          Effect.ignore,
        ),
      );
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-docker-build-",
      });
      const ctx = path.join(root, "ctx");
      yield* docker.materialize({
        context: ctx,
        dockerfile: [
          "FROM alpine:3.19 AS base",
          "RUN echo base > /stage.txt",
          "",
          "FROM alpine:3.19 AS secondary",
          "RUN echo secondary > /stage.txt",
          "",
        ].join("\n"),
        files: [],
      });
      yield* docker.image.build({ tag, context: ctx, target: "secondary" });
      const out = yield* docker.run(["run", "--rm", tag, "cat", "/stage.txt"]);
      expect(out.stdout.trim()).toBe("secondary");
    }),
  );
});

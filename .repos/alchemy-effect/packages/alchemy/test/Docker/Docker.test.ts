import { Docker, DockerLive } from "@/Docker";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, layer } from "alchemy-test";
import { PlatformError, SystemError } from "effect/PlatformError";
import { classifyDockerRegistryError } from "@/Docker/RegistryError.ts";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Redacted from "effect/Redacted";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

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

describe("Docker registry errors", (it) => {
  for (const [description, tag] of [
    [
      "ERROR: failed to build: failed to solve: failed to push registry.example/image:latest: unknown: blob unknown to registry",
      "DockerRegistryBlobUnknown",
    ],
    [
      "#7 ERROR: failed to push: unknown: blob unknown to registry\n------\nERROR: failed to build: failed to solve: failed to push registry.example/image:latest: unknown: blob unknown to registry\n\nView build details: docker-desktop://dashboard/build/builder/node/build-id\n",
      "DockerRegistryBlobUnknown",
    ],
    [
      "Command exited with code 1: blob unknown to registry",
      "DockerRegistryBlobUnknown",
    ],
    [
      "ERROR: unexpected status from HEAD request to https://registry.example/v2/image/blobs/sha256:abc: 503 Service Unavailable",
      "DockerRegistryUnavailable",
    ],
    ["ERROR: failed to push: 502 Bad Gateway", "DockerRegistryUnavailable"],
    ["ERROR: unexpected status: 401 Unauthorized", "PlatformError"],
    ["ERROR: unexpected status: 403 Forbidden", "PlatformError"],
    ["ERROR: unexpected status: 400 Bad Request", "PlatformError"],
    ["ERROR: failed to solve: process exited with code 1", "PlatformError"],
    [
      "ERROR: unexpected status from HEAD request to https://registry.example/v2/500/blobs/sha256:abc: 403 Forbidden",
      "PlatformError",
    ],
    [
      'ERROR: failed to solve: process "/bin/sh -c echo 503 Service Unavailable && exit 1" did not complete successfully: exit code: 1',
      "PlatformError",
    ],
    [
      "#7 RUN echo 'blob unknown to registry'\nERROR: process exited with code 1",
      "PlatformError",
    ],
    [
      "#7 RUN echo '503 Service Unavailable'\nERROR: process exited with code 1",
      "PlatformError",
    ],
  ] as const) {
    it.effect(`classifies ${description}`, () =>
      Effect.sync(() => {
        const error = new PlatformError(
          new SystemError({
            _tag: "Unknown",
            module: "Docker",
            method: "buildx.build",
            description,
          }),
        );
        const classified = classifyDockerRegistryError(error);
        expect(classified._tag).toBe(tag);
        if (classified._tag === "PlatformError") {
          expect(classified).toBe(error);
        } else {
          expect(classified.cause).toBe(error);
          expect(classified.message).toBe(error.message);
        }
      }),
    );
  }
});

/**
 * A `docker` CLI stand-in that answers `buildx version` with the given
 * plugin version (or fails it like a missing plugin when `undefined`),
 * records every other invocation (args + env), and exits 0.
 */
const fakeDocker = (buildxVersion: string | undefined) => {
  const calls: Array<{
    args: ReadonlyArray<string>;
    env: Record<string, string | undefined>;
  }> = [];
  const encode = (text: string) => new TextEncoder().encode(text);
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert(command._tag === "StandardCommand");
      const probe =
        command.args[0] === "buildx" && command.args[1] === "version";
      if (!probe) {
        calls.push({ args: command.args, env: command.options.env ?? {} });
      }
      const missing = probe && buildxVersion === undefined;
      const stdout =
        probe && !missing
          ? `github.com/docker/buildx ${buildxVersion} 503f948aadbddb6de3ec5581f766e1d27f6975a1\n`
          : "";
      const stderr = missing
        ? "docker: 'buildx' is not a docker command.\n"
        : "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(missing ? 1 : 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encode(stdout)),
        stderr: Stream.make(encode(stderr)),
        all: Stream.make(encode(stdout + stderr)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  return {
    calls,
    // `fresh` sidesteps the describe-level memoized `DockerLive` so the
    // fake spawner is actually wired in.
    layer: Layer.fresh(DockerLive).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  };
};

const registry = {
  server: "registry.invalid",
  username: "publisher",
  password: Redacted.make("DESTINATION_SECRET_SENTINEL"),
};

describe("Docker.image", (it) => {
  it.effect("exports straight to the registry on Buildx >= 0.26", () =>
    Effect.gen(function* () {
      const fake = fakeDocker("v0.26.1");
      yield* Effect.gen(function* () {
        const docker = yield* Docker;
        yield* docker.image.build(
          {
            context: "/ctx",
            tag: "registry.invalid/app:1",
            platform: "linux/amd64",
          },
          undefined,
          registry,
        );
      }).pipe(Effect.provide(fake.layer));
      expect(fake.calls).toHaveLength(1);
      const [build] = fake.calls;
      expect(build!.args.slice(0, 3)).toEqual(["buildx", "build", "--push"]);
      expect(build!.args).toContain("/ctx");
      expect(build!.args).toContain("registry.invalid/app:1");
      expect(build!.env.DOCKER_CONFIG).toBeUndefined();
      const auth = JSON.parse(build!.env.DOCKER_AUTH_CONFIG!) as {
        auths: Record<string, { auth: string }>;
      };
      expect(auth.auths["registry.invalid"]!.auth).toBe(
        Buffer.from("publisher:DESTINATION_SECRET_SENTINEL").toString("base64"),
      );
    }),
  );

  for (const version of ["v0.23.0-desktop.1", "v0.25.0"]) {
    it.effect(`builds locally then pushes on Buildx ${version}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fake = fakeDocker(version);
        yield* Effect.gen(function* () {
          const docker = yield* Docker;
          yield* docker.image.build(
            {
              context: "/ctx",
              tag: "registry.invalid/app:1",
              platform: "linux/amd64",
            },
            undefined,
            registry,
          );
        }).pipe(Effect.provide(fake.layer));
        expect(fake.calls).toHaveLength(2);
        const [build, push] = fake.calls;
        // `--load` so non-loading (docker-container) builders still land the
        // image in the local store for the follow-up push.
        expect(build!.args.slice(0, 3)).toEqual(["buildx", "build", "--load"]);
        expect(build!.args).toContain("/ctx");
        expect(build!.args).toContain("--platform");
        expect(build!.args).not.toContain("--push");
        expect(build!.env.DOCKER_AUTH_CONFIG).toBeUndefined();
        expect(build!.env.DOCKER_CONFIG).toBeUndefined();
        expect(push!.args).toEqual([
          "push",
          "--platform",
          "linux/amd64",
          "registry.invalid/app:1",
        ]);
        expect(push!.env.DOCKER_AUTH_CONFIG).toBeUndefined();
        // The isolated config is written under a temp dir for the push only
        // and removed once the push scope closes.
        const dir = push!.env.DOCKER_CONFIG;
        assert(dir !== undefined);
        expect(path.basename(dir)).toMatch(/^alchemy-docker-/);
        expect(yield* fs.exists(dir)).toBe(false);
      }),
    );
  }

  it.effect("falls back to build + push when Buildx is not installed", () =>
    Effect.gen(function* () {
      const fake = fakeDocker(undefined);
      yield* Effect.gen(function* () {
        const docker = yield* Docker;
        yield* docker.image.build(
          { context: "/ctx", tag: "registry.invalid/app:1" },
          undefined,
          registry,
        );
      }).pipe(Effect.provide(fake.layer));
      expect(fake.calls.map((call) => call.args.slice(0, 2))).toEqual([
        ["image", "build"],
        ["push", "registry.invalid/app:1"],
      ]);
    }),
  );

  it.effect("builds without registry credentials via image build", () =>
    Effect.gen(function* () {
      const fake = fakeDocker("v0.26.1");
      yield* Effect.gen(function* () {
        const docker = yield* Docker;
        yield* docker.image.build({ context: "/ctx", tag: "local/app:1" });
      }).pipe(Effect.provide(fake.layer));
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.args.slice(0, 2)).toEqual(["image", "build"]);
      expect(fake.calls[0]!.env.DOCKER_AUTH_CONFIG).toBeUndefined();
    }),
  );

  for (const [name, auth] of [
    [
      "invalid JSON",
      '{"auths":{"source.invalid":{"auth":"AUTH_SECRET_SENTINEL"}},',
    ],
    [
      "invalid base64",
      '{"auths":{"source.invalid":{"auth":"AUTH_SECRET_SENTINEL!"}}}',
    ],
    [
      "missing credential separator",
      '{"auths":{"source.invalid":{"auth":"QVVUSF9TRUNSRVRfU0VOVElORUw="}}}',
    ],
  ]) {
    it.effect(`rejects ${name} without exposing registry credentials`, () =>
      Effect.gen(function* () {
        const fake = fakeDocker("v0.26.1");
        const result = yield* Effect.gen(function* () {
          const docker = yield* Docker;
          return yield* docker.image
            .build(
              { context: "/ctx", tag: "registry.invalid/invalid-auth:latest" },
              undefined,
              registry,
            )
            .pipe(Effect.flip);
        }).pipe(Effect.provide(fake.layer));
        assert(result._tag === "PlatformError");
        expect(result.reason._tag).toBe("InvalidData");
        expect(result.reason.description).toContain("DOCKER_AUTH_CONFIG");
        expect(fake.calls).toHaveLength(0);
        const serialized = yield* Effect.sync(() => JSON.stringify(result));
        expect(serialized).not.toContain("AUTH_SECRET_SENTINEL");
        expect(serialized).not.toContain("QVVUSF9TRUNSRVRfU0VOVElORUw=");
        expect(serialized).not.toContain("DESTINATION_SECRET_SENTINEL");
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ DOCKER_AUTH_CONFIG: auth }),
          ),
        ),
      ),
    );
  }

  it.effect("builds a minimal image with content Dockerfile", () =>
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

  it.effect("passes --platform and --build-arg", () =>
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

  it.effect("respects multi-stage --target", () =>
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

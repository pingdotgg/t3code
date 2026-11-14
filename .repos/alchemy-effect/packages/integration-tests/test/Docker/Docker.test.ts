import { Docker, DockerLive, dockerLive } from "@alchemy.run/docker";
import type { RegistryCredentials } from "@alchemy.run/docker/Docker";
import { classifyDockerRegistryError } from "@alchemy.run/docker/RegistryError";
import { assert, expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { PlatformError, SystemError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { authenticatedRegistry, scopedBuildx } from "./Runtime.ts";

const describe = layer(
  Layer.provideMerge(DockerLive, Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
);

// Which CLI the client runs: declared in code, overridable by DOCKER_BIN.
describe("Docker CLI binary", (it) => {
  const version = (layer: Layer.Layer<Docker, never, any>) =>
    Effect.gen(function* () {
      const docker = yield* Docker;
      return (yield* docker.run(["--version"])).stdout;
    }).pipe(Effect.provide(layer));

  it.effect(
    "runs the bin declared in code",
    () =>
      Effect.gen(function* () {
        const error = yield* version(dockerLive({ bin: "alchemy-test-no-such-cli" })).pipe(
          Effect.flip,
        );
        expect(String(error)).toContain("alchemy-test-no-such-cli");
        expect(yield* version(dockerLive({ bin: "docker" }))).toMatch(/^Docker version/);
      }).pipe(
        // Ignore any DOCKER_BIN in the host environment for this case.
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      ),
    { tags: ["provider:docker", "local"] },
  );

  it.effect(
    "lets DOCKER_BIN override the bin declared in code",
    () =>
      Effect.gen(function* () {
        const output = yield* version(dockerLive({ bin: "alchemy-test-no-such-cli" }));
        expect(output).toMatch(/^Docker version/);
      }).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DOCKER_BIN: "docker" }))),
      ),
    { tags: ["provider:docker", "local"] },
  );
});

describe("Docker.materialize", (it) => {
  it.effect(
    "materializes a Dockerfile in the target directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const docker = yield* Docker;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-ctx-" });
        const ctx = path.join(root, "ctx");
        yield* docker.materialize({ context: ctx, dockerfile: "FROM scratch\n", files: [] });
        const dockerfile = path.join(ctx, "Dockerfile");
        expect(yield* fs.exists(dockerfile)).toBe(true);
        expect(yield* fs.readFileString(dockerfile)).toBe("FROM scratch\n");
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  it.effect(
    "writes nested context files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const docker = yield* Docker;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-path-" });
        const ctx = path.join(root, "ctx");
        yield* docker.materialize({
          context: ctx,
          dockerfile: "FROM scratch\n",
          files: [{ path: "nested/hello.txt", content: "hi" }],
        });
        expect(yield* fs.readFileString(path.join(ctx, "nested", "hello.txt"))).toBe("hi");
      }),
    { tags: ["unit", "provider:docker", "local"] },
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
    ["Command exited with code 1: blob unknown to registry", "DockerRegistryBlobUnknown"],
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
    ["#7 RUN echo 'blob unknown to registry'\nERROR: process exited with code 1", "PlatformError"],
    ["#7 RUN echo '503 Service Unavailable'\nERROR: process exited with code 1", "PlatformError"],
  ] as const) {
    it.effect(
      `classifies ${description}`,
      () =>
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
      { tags: ["unit", "provider:docker", "provider:docker:registry", "local"] },
    );
  }
});

const buildScratchImage = Effect.fn(function* (
  label: string,
  tag: string | [string, ...Array<string>],
  credentials: RegistryCredentials,
  platform?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-publish-" });
  yield* fs.writeFileString(
    path.join(root, "Dockerfile"),
    `FROM scratch\nLABEL alchemy.test=${label}\n`,
  );
  // A fresh service re-probes the Buildx plugin pinned by `scopedBuildx`.
  return yield* Effect.gen(function* () {
    const docker = yield* Docker;
    return yield* docker.image.build({ context: root, tag, platform }, undefined, credentials);
  }).pipe(Effect.provide(Layer.fresh(DockerLive)));
});

describe("Docker.image", (it) => {
  it.effect(
    "streams real pull output through deployment notes",
    () =>
      Effect.gen(function* () {
        const docker = yield* Docker;
        const notes: Array<{ message: string; kind?: string }> = [];
        const session = {
          note: (message: string, options?: { kind?: "status" | "output" }) =>
            Effect.sync(() => {
              notes.push({ message, kind: options?.kind });
            }),
        };
        yield* docker.image.pull("alpine:3.21", "linux/amd64", undefined, session);
        expect(notes.length).toBeGreaterThan(0);
        expect(notes.every((note) => note.kind === "output")).toBe(true);
        expect(notes.some((note) => note.message.includes("alpine:3.21"))).toBe(true);
      }),
    { tags: ["provider:docker", "local"], timeout: 120_000 },
  );
});

describe("Docker.image publication", (it) => {
  for (const [name, version, platform] of [
    ["exports straight to the registry on Buildx >= 0.26", "v0.26.1", "linux/amd64"],
    ["builds with --load then pushes on Buildx < 0.26", "v0.25.0", "linux/amd64"],
    ["builds then pushes without a Buildx plugin", undefined, undefined],
  ] as const) {
    it.effect(
      name,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const docker = yield* Docker;
          const registry = yield* authenticatedRegistry();
          const tags: [string, string] = [
            `${registry.host}/app:1`,
            `${registry.host}/app:buildcache`,
          ];
          yield* Effect.addFinalizer(() => docker.image.remove(tags, true).pipe(Effect.ignore));
          const { config } = yield* scopedBuildx(version);

          yield* buildScratchImage(version ?? "legacy", tags, registry.credentials, platform);

          expect(yield* registry.hasManifest("app", "1")).toBe(true);
          expect(yield* registry.hasManifest("app", "buildcache")).toBe(true);
          // Credentials ride per-invocation env/temp config, never the CLI's own.
          const cliConfig = path.join(config, "config.json");
          if (yield* fs.exists(cliConfig)) {
            expect(yield* fs.readFileString(cliConfig)).not.toContain(registry.host);
          }
        }).pipe(
          // Registry readiness and the Buildx download retry on real time.
          TestClock.withLive,
        ),
      { tags: ["provider:docker", "local"], exclusive: true, timeout: 180_000 },
    );
  }

  for (const [name, auth] of [
    ["invalid JSON", '{"auths":{"source.invalid":{"auth":"AUTH_SECRET_SENTINEL"}},'],
    ["invalid base64", '{"auths":{"source.invalid":{"auth":"AUTH_SECRET_SENTINEL!"}}}'],
    [
      "missing credential separator",
      '{"auths":{"source.invalid":{"auth":"QVVUSF9TRUNSRVRfU0VOVElORUw="}}}',
    ],
  ]) {
    it.effect(
      `rejects ${name} DOCKER_AUTH_CONFIG without exposing registry credentials`,
      () =>
        Effect.gen(function* () {
          const registry = yield* authenticatedRegistry();
          yield* scopedBuildx("v0.26.1");

          const result = yield* buildScratchImage(
            "invalid-auth",
            `${registry.host}/invalid-auth:1`,
            {
              ...registry.credentials,
              password: Redacted.make("DESTINATION_SECRET_SENTINEL"),
            },
          ).pipe(
            Effect.flip,
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ DOCKER_AUTH_CONFIG: auth })),
            ),
          );
          assert(result._tag === "PlatformError");
          expect(result.reason._tag).toBe("InvalidData");
          expect(result.reason.description).toContain("DOCKER_AUTH_CONFIG");
          const serialized = yield* Effect.sync(() => JSON.stringify(result));
          expect(serialized).not.toContain("AUTH_SECRET_SENTINEL");
          expect(serialized).not.toContain("QVVUSF9TRUNSRVRfU0VOVElORUw=");
          expect(serialized).not.toContain("DESTINATION_SECRET_SENTINEL");
          // Rejected before anything was built or published.
          expect(yield* registry.hasManifest("invalid-auth", "1")).toBe(false);
        }).pipe(
          // Registry readiness and the Buildx download retry on real time.
          TestClock.withLive,
        ),
      { tags: ["provider:docker", "local"], exclusive: true, timeout: 180_000 },
    );
  }
});

// How a failing `docker` command is reported, against the real CLI.
describe("Docker.run failure output", (it) => {
  it.effect(
    "says so when a failing command wrote nothing",
    () =>
      Effect.gen(function* () {
        const docker = yield* Docker;
        const error = yield* docker
          .run(["run", "--rm", "alpine:3.19", "sh", "-c", "exit 3"])
          .pipe(Effect.flip);
        expect(error.reason._tag).toBe("Unknown");
        expect(error.reason.description).toContain("exited with code 3");
        expect(error.reason.description).toContain("wrote no output");
      }),
    { tags: ["provider:docker", "local"], timeout: 60_000 },
  );

  it.effect(
    "keeps stdout and stderr from a failing command",
    () =>
      Effect.gen(function* () {
        const docker = yield* Docker;
        const error = yield* docker
          .run([
            "run",
            "--rm",
            "alpine:3.19",
            "sh",
            "-c",
            "echo step-log-on-stdout; echo reason-on-stderr >&2; exit 1",
          ])
          .pipe(Effect.flip);
        expect(error.reason.description).toContain("step-log-on-stdout");
        expect(error.reason.description).toContain("reason-on-stderr");
        // The reason (stderr) comes first.
        expect(error.reason.description!.indexOf("reason-on-stderr")).toBeLessThan(
          error.reason.description!.indexOf("step-log-on-stdout"),
        );
      }),
    { tags: ["provider:docker", "local"], timeout: 60_000 },
  );

  it.effect(
    "still classifies a daemon NotFound from stderr",
    () =>
      Effect.gen(function* () {
        const docker = yield* Docker;
        const error = yield* docker
          .run(["image", "inspect", "alchemy-test-no-such-image:missing"])
          .pipe(Effect.flip);
        expect(error.reason._tag).toBe("NotFound");
      }),
    { tags: ["provider:docker", "local"] },
  );
});

describe("Docker.image", (it) => {
  it.effect(
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
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-build-" });
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
    { tags: ["unit", "provider:docker", "local"] },
  );

  it.effect(
    "passes --platform and --build-arg",
    () =>
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
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-build-" });
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
    { tags: ["unit", "provider:docker", "local"] },
  );

  it.effect(
    "passes --secret through the environment and keeps it out of the image",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const docker = yield* Docker;
        const tag = "alchemy-docker-test:secret";
        const value = "alchemy-build-secret-value";
        yield* Effect.addFinalizer(() =>
          docker.image.remove(tag, true).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
            Effect.ignore,
          ),
        );
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-build-" });
        const ctx = path.join(root, "ctx");
        yield* docker.materialize({
          context: ctx,
          dockerfile: [
            "FROM alpine:3.19",
            // `PATH` as an id proves the value does not ride in a variable of
            // that name: shadowing it would break `docker` itself.
            "RUN --mount=type=secret,id=PATH,required=true " +
              "wc -c < /run/secrets/PATH > /length.txt",
            "",
          ].join("\n"),
          files: [],
        });
        yield* docker.image.build({
          tag,
          context: ctx,
          secrets: { PATH: Redacted.make(value) },
        });
        const out = yield* docker.run(["run", "--rm", tag, "cat", "/length.txt"]);
        expect(out.stdout.trim()).toBe(String(value.length));
        const history = yield* docker.run(["image", "history", "--no-trunc", tag]);
        expect(history.stdout).not.toContain(value);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  it.effect(
    "respects multi-stage --target",
    () =>
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
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-docker-build-" });
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
    { tags: ["unit", "provider:docker", "local"] },
  );
});

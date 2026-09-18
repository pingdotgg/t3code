import { Docker } from "@/Docker/Docker.ts";
import { Stage } from "@/Stage.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const withBuilder =
  (prefix: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const name = `${prefix}-${yield* Stage}`;
      const docker = yield* Docker;
      return yield* Effect.acquireUseRelease(
        docker.run([
          "buildx",
          "create",
          "--name",
          name,
          "--driver",
          "docker-container",
        ]),
        () =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const previous = {
                builder: process.env.BUILDX_BUILDER,
                attestations: process.env.BUILDX_NO_DEFAULT_ATTESTATIONS,
              };
              process.env.BUILDX_BUILDER = name;
              process.env.BUILDX_NO_DEFAULT_ATTESTATIONS = "false";
              return previous;
            }),
            () =>
              docker
                .run(["buildx", "inspect", "--bootstrap"])
                .pipe(Effect.andThen(effect)),
            (previous) =>
              Effect.sync(() => {
                if (previous.builder === undefined)
                  delete process.env.BUILDX_BUILDER;
                else process.env.BUILDX_BUILDER = previous.builder;
                if (previous.attestations === undefined)
                  delete process.env.BUILDX_NO_DEFAULT_ATTESTATIONS;
                else
                  process.env.BUILDX_NO_DEFAULT_ATTESTATIONS =
                    previous.attestations;
              }),
          ),
        () => docker.run(["buildx", "rm", "--force", name]).pipe(Effect.orDie),
      );
    });

/**
 * Whether the installed Buildx can export straight to a registry
 * (`buildx build --push` authenticating via DOCKER_AUTH_CONFIG, 0.26+).
 * Older plugins make the provider `--load` the image and `docker push` it.
 */
export const supportsRegistryExport = Effect.gen(function* () {
  const docker = yield* Docker;
  const version = yield* docker.run(["buildx", "version"]);
  const match = /buildx v(\d+)\.(\d+)\./.exec(version.stdout);
  if (!match) return false;
  return Number(match[1]) >= 1 || Number(match[2]) >= 26;
});

const decodeBuild = Schema.Struct({
  ref: Schema.String,
  status: Schema.String,
}).pipe(Schema.fromJsonString, Schema.decodeEffect);

export const buildHistory = Effect.gen(function* () {
  const docker = yield* Docker;
  const history = yield* docker.run([
    "buildx",
    "history",
    "ls",
    "--format",
    "json",
  ]);
  return yield* Effect.forEach(
    history.stdout.split("\n").filter(Boolean),
    (line) => decodeBuild(line),
  );
});

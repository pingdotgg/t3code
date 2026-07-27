import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Artifacts from "../Artifacts.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Docker, dockerPhysicalName } from "./Docker.ts";
import type { Providers } from "./Providers.ts";
import {
  type ImageRegistry,
  parseCreatedAt,
  parseRepoDigest,
  repositoryFromImageRef,
  withRegistryHost,
} from "./Registry.ts";

export interface DockerBuildOptions {
  /**
   * Build context directory.
   *
   * @default Current working directory.
   */
  context?: string;
  /**
   * Dockerfile path, relative to the context unless absolute.
   *
   * @default "Dockerfile"
   */
  dockerfile?: string;
  /** Target platform, e.g. `"linux/amd64"`. */
  platform?: string;
  /** Docker build arguments. */
  args?: Record<string, string>;
  /** Multi-stage build target. */
  target?: string;
  /** Cache sources passed as `--cache-from`. */
  cacheFrom?: string[];
  /** Cache destinations passed as `--cache-to`. */
  cacheTo?: string[];
  /** Additional Docker build options. */
  options?: string[];
}

export interface ImageProps {
  /**
   * Repository/name for the built image.
   *
   * @default Generated from stack, stage, logical id, and instance id.
   */
  name?: string;
  /** Image tag. @default "latest" */
  tag?: string;
  /** Registry credentials for push. */
  registry?: ImageRegistry;
  /** Skip registry push even when `registry` is set. @default false */
  skipPush?: boolean;
  /** Docker build configuration. */
  build: DockerBuildOptions;
}

export interface Image extends Resource<
  "Docker.Image",
  ImageProps,
  {
    /** Image repository/name without tag. */
    name: string;
    /** Final image reference. Includes registry host when pushed there. */
    imageRef: string;
    /** Local image id after build/tag. */
    imageId: string;
    /** Registry digest after push when available. */
    repoDigest?: string;
    /** Tag used for the local image. */
    tag: string;
    /** Build timestamp in milliseconds since epoch. */
    builtAt: number;
  },
  never,
  Providers
> {}

/**
 * Builds, tags, and optionally pushes Docker images through the active Docker
 * context.
 *
 * This resource uses the Docker CLI and whatever daemon or remote context the
 * CLI is configured to target. It is separate from `Cloudflare.Container`;
 * registry image references are the boundary between Docker-managed images and
 * cloud container platforms.
 *
 * `Image` always builds from a Dockerfile. To pull (and optionally re-tag and
 * push) an existing registry image, use `Docker.RemoteImage`.
 *
 * @resource
 *
 * @section Building Images
 * @example Build from a Dockerfile
 * ```typescript
 * const image = yield* Docker.Image("app", {
 *   name: "my-app",
 *   tag: "latest",
 *   build: {
 *     context: "./app",
 *     dockerfile: "Dockerfile",
 *     args: { NODE_ENV: "production" },
 *   },
 * });
 * ```
 *
 * @section Registry Push
 * @example Push with Redacted credentials
 * ```typescript
 * const image = yield* Docker.Image("app", {
 *   name: "my-app",
 *   build: { context: "./app" },
 *   registry: {
 *     server: "ghcr.io",
 *     username: "octocat",
 *     password: Config.redacted("GITHUB_TOKEN"),
 *   },
 * });
 * ```
 */
export const Image = Resource<Image>("Docker.Image");

export const ImageProvider = () =>
  Provider.effect(
    Image,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;

      const buildAndInspectImage = Effect.fn(function* (
        id: string,
        props: ImageProps,
        instanceId: string,
      ) {
        const name = yield* dockerPhysicalName(id, props, instanceId);
        const tag = props.tag ?? "latest";
        const ref = `${name}:${tag}`;

        const paths = yield* resolveBuildPaths(props.build);
        yield* docker.image.build({
          tag: ref,
          context: paths.context,
          file: paths.dockerfile,
          platform: props.build.platform,
          target: props.build.target,
          "build-arg": props.build.args,
          "cache-from": props.build.cacheFrom,
          "cache-to": props.build.cacheTo,
          args: props.build.options,
        });

        // Read the freshly built image's id and creation time straight from
        // Docker rather than synthesizing a wall-clock timestamp.
        return {
          name,
          tag,
          image: yield* docker.image.inspect(ref),
          ref,
        };
      }, Artifacts.cached("build"));

      const resolveBuildPaths = Effect.fn(function* (
        build: DockerBuildOptions,
      ) {
        const cwd = yield* Effect.sync(() => process.cwd());
        const context = path.resolve(build.context ?? cwd);
        const dockerfile = build.dockerfile
          ? path.isAbsolute(build.dockerfile)
            ? build.dockerfile
            : path.resolve(context, build.dockerfile)
          : path.resolve(context, "Dockerfile");
        if (!(yield* fs.exists(context))) {
          return yield* Effect.die(
            `Docker build context does not exist: ${context}`,
          );
        }
        if (!(yield* fs.exists(dockerfile))) {
          return yield* Effect.die(`Dockerfile does not exist: ${dockerfile}`);
        }
        return { context, dockerfile };
      });

      return Image.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const ref =
            output?.imageRef ??
            (yield* dockerPhysicalName(id, olds, instanceId).pipe(
              Effect.map((name) => `${name}:${olds.tag ?? "latest"}`),
            ));
          const image = yield* docker.image
            .inspect(ref)
            .pipe(
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.undefined,
              ),
            );
          if (!image) return undefined;
          return {
            name: output?.name ?? repositoryFromImageRef(ref),
            imageRef: ref,
            imageId: image.Id,
            repoDigest: output?.repoDigest,
            tag: output?.tag ?? olds.tag ?? "latest",
            builtAt: output?.builtAt ?? parseCreatedAt(image.Created),
          };
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const { image } = yield* buildAndInspectImage(id, news, instanceId);
          if (output?.imageId !== image.Id) {
            return { action: "update" };
          }
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, session }) {
          const { name, tag, image, ref } = yield* buildAndInspectImage(
            id,
            news,
            instanceId,
          );

          let repoDigest: string | undefined;
          let targetImageRef: string = ref;
          if (news.registry && !news.skipPush) {
            yield* session.note(
              `Pushing image to registry "${news.registry.server}"`,
            );
            targetImageRef = withRegistryHost(ref, news.registry);
            repoDigest = yield* docker.image
              .push(ref, news.registry)
              .pipe(
                Effect.map((result) => parseRepoDigest(ref, result.stdout)),
              );
          }

          return {
            name,
            imageRef: targetImageRef,
            imageId: image.Id,
            repoDigest,
            tag,
            builtAt: parseCreatedAt(image.Created),
          };
        }),
        delete: Effect.fn(({ output }) =>
          docker.image
            .remove(output.imageRef)
            .pipe(
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.void,
              ),
            ),
        ),
      });
    }),
  );

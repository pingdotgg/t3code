import * as Artifacts from "alchemy/Artifacts";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import { Docker, dockerContextName, dockerPhysicalName } from "./Docker.ts";
import type { Providers } from "./Providers.ts";
import {
  type ImageRegistry,
  parseCreatedAt,
  publishedRepoDigest,
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
  /**
   * Docker build arguments (`--build-arg`). Never pass secrets here: build
   * args are visible in the image history. Use {@link secrets} instead.
   */
  args?: Record<string, string>;
  /**
   * BuildKit secrets, keyed by id. Mount one in a `RUN` step with
   * `--mount=type=secret,id=<id>` and read it from `/run/secrets/<id>`, or
   * add `env=<NAME>` to expose it as an environment variable for that step.
   * A secret never enters the image, its build history, or `docker`'s argv.
   */
  secrets?: Record<string, Redacted.Redacted<string>>;
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
  /**
   * Registry credentials. The image is pushed to this registry (unless
   * `skipPush`), and the build itself authenticates with them, so private
   * base images and `type=registry` caches hosted there resolve without a
   * host `docker login`. Credentials already in `DOCKER_AUTH_CONFIG` for
   * other registries are kept. Build-time authentication needs Buildx 0.26+
   * (Docker Desktop 4.44+) or the legacy builder; older Buildx plugins ignore
   * it, so a private base image there still needs `docker login`.
   */
  registry?: ImageRegistry;
  /** Skip registry push even when `registry` is set. @default false */
  skipPush?: boolean;
  /** Docker context name or context resource. */
  context?: Docker.ContextRef;
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
 *
 * ### Building Images
 * **Example:** Build from a Dockerfile
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
 * ### Build Secrets
 * **Example:** Install from a private npm registry
 * ```typescript
 * // Dockerfile:
 * //   RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN npm ci
 * const image = yield* Docker.Image("app", {
 *   name: "my-app",
 *   build: {
 *     context: "./app",
 *     secrets: { NPM_TOKEN: Config.Redacted("NPM_TOKEN") },
 *   },
 * });
 * ```
 *
 * The secret is mounted only into the `RUN` step that asks for it; it never
 * lands in an image layer or the build history.
 *
 * ### Registry Push
 * **Example:** Push with Redacted credentials
 * ```typescript
 * const image = yield* Docker.Image("app", {
 *   name: "my-app",
 *   build: { context: "./app" },
 *   registry: {
 *     server: "ghcr.io",
 *     username: "octocat",
 *     password: Config.Redacted("GITHUB_TOKEN"),
 *   },
 * });
 * ```
 *
 * ### Private Base Images and Registry Caches
 * **Example:** Build FROM a private base image with a registry cache
 * ```typescript
 * // Dockerfile: FROM registry.example.com/base:v1
 * const image = yield* Docker.Image("app", {
 *   name: "registry.example.com/app",
 *   build: {
 *     context: "./app",
 *     cacheFrom: ["type=registry,ref=registry.example.com/app:buildcache"],
 *     cacheTo: ["type=registry,ref=registry.example.com/app:buildcache,mode=max"],
 *   },
 *   // Authenticates the base-image pull and cache import/export, then the push.
 *   registry: {
 *     server: "registry.example.com",
 *     username: "deploy",
 *     password: Config.Redacted("REGISTRY_PASSWORD"),
 *   },
 * });
 * ```
 *
 * ### Docker Context
 * **Example:** Build in a named Docker context
 * ```typescript
 * const image = yield* Docker.Image("app", {
 *   name: "my-app",
 *   context: "remote-build",
 *   build: { context: "./app" },
 * });
 * ```
 *
 * @resource
 * @product Image
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
        const engineContext = dockerContextName(props.context);
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
          secrets: props.build.secrets,
          "cache-from": props.build.cacheFrom,
          "cache-to": props.build.cacheTo,
          args: props.build.options,
          engineContext,
          // Base images and registry caches may live in the same registry;
          // the push itself stays in `reconcile`.
          credentials: props.registry,
        });

        // Read the freshly built image's id and creation time straight from
        // Docker rather than synthesizing a wall-clock timestamp.
        return {
          name,
          tag,
          image: yield* docker.image.inspect(ref, engineContext),
          ref,
        };
      }, Artifacts.cached("build"));

      const resolveBuildPaths = Effect.fn(function* (build: DockerBuildOptions) {
        const cwd = yield* Effect.sync(() => process.cwd());
        const context = path.resolve(build.context ?? cwd);
        const dockerfile = build.dockerfile
          ? path.isAbsolute(build.dockerfile)
            ? build.dockerfile
            : path.resolve(context, build.dockerfile)
          : path.resolve(context, "Dockerfile");
        if (!(yield* fs.exists(context))) {
          return yield* Effect.die(`Docker build context does not exist: ${context}`);
        }
        if (!(yield* fs.exists(dockerfile))) {
          return yield* Effect.die(`Dockerfile does not exist: ${dockerfile}`);
        }
        return { context, dockerfile };
      });

      return Image.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const context = dockerContextName(olds.context);
          const ref =
            output?.imageRef ??
            (yield* dockerPhysicalName(id, olds, instanceId).pipe(
              Effect.map((name) => `${name}:${olds.tag ?? "latest"}`),
            ));
          const image = yield* docker.image
            .inspect(ref, context)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
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
        diff: Effect.fn(function* ({ id, instanceId, news, output, olds }) {
          if (!isResolved(news) || !output) return undefined;
          if (dockerContextName(olds.context) !== dockerContextName(news.context)) {
            return { action: "update" };
          }
          const { image } = yield* buildAndInspectImage(id, news, instanceId);
          if (output?.imageId !== image.Id) {
            return { action: "update" };
          }
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, session }) {
          const context = dockerContextName(news.context);
          const { name, tag, image, ref } = yield* buildAndInspectImage(id, news, instanceId);

          let repoDigest: string | undefined;
          let targetImageRef: string = ref;
          if (news.registry && !news.skipPush) {
            yield* session.note(`Pushing image to registry "${news.registry.server}"`);
            targetImageRef = withRegistryHost(ref, news.registry);
            const pushed = yield* docker.image.push(ref, news.registry, undefined, context);
            const published = yield* docker.image.inspect(ref, context);
            repoDigest = publishedRepoDigest(ref, pushed, published.RepoDigests, targetImageRef);
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
        delete: Effect.fn(({ olds, output }) =>
          docker.image
            .remove(output.imageRef, undefined, dockerContextName(olds.context))
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void)),
        ),
      });
    }),
  );

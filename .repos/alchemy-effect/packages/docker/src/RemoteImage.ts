import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import { Docker, dockerContextName } from "./Docker.ts";
import type { Providers } from "./Providers.ts";
import {
  type ImageRegistry,
  parseCreatedAt,
  publishedRepoDigest,
  repositoryFromImageRef,
  withRegistryHost,
} from "./Registry.ts";

export interface RemoteImageProps {
  /** Docker image name to use as the source, without tag. */
  name: string;
  /** Docker source image tag. @default "latest" */
  tag?: string;
  /** Pull for this platform when the source is not already local or alwaysPull is enabled. */
  platform?: string;
  /**
   * Always pull the source image, even when that reference exists locally.
   *
   * @default true
   */
  alwaysPull?: boolean;
  /**
   * Re-tag the pulled image under this repository/name. When omitted the pulled
   * `name` is kept.
   */
  targetName?: string;
  /**
   * Tag applied to the re-tagged image.
   *
   * @default The pulled `tag`.
   */
  targetTag?: string;
  /** Registry credentials. When set, the (re-tagged) image is pushed. */
  registry?: ImageRegistry;
  /**
   * Skip registry push even when `registry` is set.
   *
   * @default false
   */
  skipPush?: boolean;
  /** Docker context name or context resource. */
  context?: Docker.ContextRef;
}

export interface RemoteImage extends Resource<
  "Docker.RemoteImage",
  RemoteImageProps,
  {
    /** Final image reference. Includes the registry host when pushed there. */
    imageRef: string;
    /** Local image id after reuse or pull. */
    imageId: string;
    /** Source image id used for the last reconcile, preserved across refresh. */
    sourceImageId?: string;
    /** Pull timestamp in milliseconds since epoch. */
    createdAt: number;
    /** Final image repository/name. */
    name: string;
    /** Final image tag. */
    tag: string;
    /** Registry digest after push when available. */
    repoDigest?: string;
  },
  never,
  Providers
> {}

/**
 * Makes a source Docker image available through the active Docker context,
 * optionally re-tagging it and pushing it to a registry.
 *
 * The image is available to other Docker resources by `imageRef`. Use
 * `alwaysPull: false` reuses the source tag when it exists in the configured
 * Docker daemon, pulling only when it is missing. Set `targetName`/`targetTag`
 * to re-tag the source image, and `registry` to push it (mirroring it from a
 * source registry into your own, for example).
 *
 *
 * ### Pulling Images
 * **Example:** Pull nginx
 * ```typescript
 * const nginx = yield* Docker.RemoteImage("nginx", {
 *   name: "nginx",
 *   tag: "alpine",
 * });
 * ```
 *
 * **Example:** Reuse an existing daemon tag
 * ```typescript
 * const postgres = yield* Docker.RemoteImage("postgres", {
 *   name: "postgres",
 *   tag: "18-alpine",
 *   alwaysPull: false,
 * });
 * ```
 *
 * ### Re-tagging and Pushing
 * **Example:** Mirror a public image into your registry
 * ```typescript
 * const mirrored = yield* Docker.RemoteImage("nginx-mirror", {
 *   name: "nginx",
 *   tag: "alpine",
 *   targetName: "acme/nginx",
 *   targetTag: "alpine",
 *   registry: {
 *     server: "ghcr.io",
 *     username: "octocat",
 *     password: Config.Redacted("GITHUB_TOKEN"),
 *   },
 * });
 * ```
 *
 * ### Docker Context
 * **Example:** Pull through a named Docker context
 * ```typescript
 * const nginx = yield* Docker.RemoteImage("nginx", {
 *   name: "nginx",
 *   tag: "alpine",
 *   context: "remote-build",
 * });
 * ```
 *
 * @resource
 * @product Image
 */
export const RemoteImage = Resource<RemoteImage>("Docker.RemoteImage");

export const RemoteImageProvider = () =>
  Provider.effect(
    RemoteImage,
    Effect.gen(function* () {
      const docker = yield* Docker;
      const inspectImage = (ref: string, context: string | undefined) =>
        docker.image
          .inspect(ref, context)
          .pipe(Effect.catchIf(isMissingImageError, () => Effect.undefined));

      return RemoteImage.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ olds, output }) {
          const context = dockerContextName(olds.context);
          const ref = output?.imageRef ?? targetImageRef(olds);
          return yield* inspectImage(ref, context).pipe(
            Effect.map((image) =>
              image
                ? {
                    imageRef: ref,
                    imageId: image.Id,
                    createdAt: output?.createdAt ?? parseCreatedAt(image.Created),
                    sourceImageId: output?.sourceImageId ?? output?.imageId ?? image.Id,
                    name: output?.name ?? repositoryFromImageRef(ref),
                    tag: output?.tag ?? targetTag(olds),
                    repoDigest: output?.repoDigest,
                  }
                : undefined,
            ),
          );
        }),
        diff: Effect.fn(function* ({ output, news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            dockerContextName(olds.context) !== dockerContextName(news.context) ||
            !output ||
            news.alwaysPull !== false ||
            output.imageRef !== targetImageRef(news)
          ) {
            return { action: "update" };
          }
          const source = yield* inspectImage(remoteImageRef(news), dockerContextName(news.context));
          const target = yield* inspectImage(targetImageRef(news), dockerContextName(news.context));
          if (
            !source ||
            !target ||
            source.Id !== (output.sourceImageId ?? output.imageId) ||
            source.Id !== target.Id
          ) {
            return { action: "update" };
          }
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const context = dockerContextName(news.context);
          const sourceRef = remoteImageRef(news);
          let source: Docker.Image | undefined;
          if (news.alwaysPull === false) {
            source = yield* inspectImage(sourceRef, context);
            if (source) {
              yield* session.note(`Reusing local Docker image: ${sourceRef}`);
            }
          }
          if (!source) {
            yield* session.note(`Pulling Docker image: ${sourceRef}`);
            yield* docker.image.pull(sourceRef, news.platform, context);
            source = yield* docker.image.inspect(sourceRef, context);
          }

          const finalRef = targetImageRef(news);
          if (finalRef !== sourceRef || (news.registry && !news.skipPush)) {
            yield* session.note(`Tagging Docker image: ${source.Id} -> ${finalRef}`);
            yield* docker.image.tag(source.Id, finalRef, context);
          }

          let pushed: { stdout: string; stderr: string } | undefined;
          if (news.registry && !news.skipPush) {
            yield* session.note(`Pushing image to registry "${news.registry.server}"`);
            pushed = yield* docker.image.push(finalRef, news.registry, undefined, context);
          }

          const inspected = yield* docker.image.inspect(finalRef, context);
          const repoDigest =
            pushed === undefined
              ? undefined
              : publishedRepoDigest(finalRef, pushed, inspected.RepoDigests);
          return {
            imageRef: finalRef,
            imageId: inspected.Id,
            sourceImageId: source.Id,
            createdAt: parseCreatedAt(inspected.Created),
            name: repositoryFromImageRef(finalRef),
            tag: targetTag(news),
            repoDigest,
          };
        }),
        delete: Effect.fn(function* () {
          // Remote images are not removed on destroy because tags may be shared by
          // unrelated local stacks or developer workflows.
        }),
      });
    }),
  );

/** The reference the image is pulled from. */
const remoteImageRef = (props: RemoteImageProps): string =>
  `${props.name}:${props.tag ?? "latest"}`;

const isMissingImageError = (error: PlatformError): boolean =>
  error.reason._tag === "NotFound" &&
  /no such image|image not known|image not found/i.test(error.reason.description ?? "");

const targetTag = (props: RemoteImageProps): string => props.targetTag ?? props.tag ?? "latest";

/**
 * The final reference after re-tagging and registry-host prefixing. Equals the
 * pulled reference when no re-tag/registry is configured.
 */
const targetImageRef = (props: RemoteImageProps): string => {
  const local = `${props.targetName ?? props.name}:${targetTag(props)}`;
  return props.registry && !props.skipPush ? withRegistryHost(local, props.registry) : local;
};

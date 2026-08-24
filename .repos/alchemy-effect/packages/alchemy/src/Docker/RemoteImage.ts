import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Docker } from "./Docker.ts";
import type { Providers } from "./Providers.ts";
import {
  type ImageRegistry,
  parseCreatedAt,
  parseRepoDigest,
  repositoryFromImageRef,
  withRegistryHost,
} from "./Registry.ts";

export interface RemoteImageProps {
  /** Docker image name to pull, without tag. */
  name: string;
  /** Docker image tag to pull. @default "latest" */
  tag?: string;
  /** Pull for this platform. */
  platform?: string;
  /**
   * Pull even when an image with the same reference already exists locally.
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
}

export interface RemoteImage extends Resource<
  "Docker.RemoteImage",
  RemoteImageProps,
  {
    /** Final image reference. Includes the registry host when pushed there. */
    imageRef: string;
    /** Local image id after pull. */
    imageId: string;
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
 * Pulls a remote Docker image through the active Docker context, optionally
 * re-tagging it and pushing it to a registry.
 *
 * The image is available to other Docker resources by `imageRef`. Use
 * `alwaysPull: false` when you want to reuse an existing tag in the configured
 * Docker daemon instead of pulling on every deploy. Set `targetName`/`targetTag`
 * to re-tag the pulled image, and `registry` to push it (mirroring it from a
 * source registry into your own, for example).
 *
 * @resource
 *
 * @section Pulling Images
 * @example Pull nginx
 * ```typescript
 * const nginx = yield* Docker.RemoteImage("nginx", {
 *   name: "nginx",
 *   tag: "alpine",
 * });
 * ```
 *
 * @example Reuse an existing daemon tag
 * ```typescript
 * const postgres = yield* Docker.RemoteImage("postgres", {
 *   name: "postgres",
 *   tag: "18-alpine",
 *   alwaysPull: false,
 * });
 * ```
 *
 * @section Re-tagging and Pushing
 * @example Mirror a public image into your registry
 * ```typescript
 * const mirrored = yield* Docker.RemoteImage("nginx-mirror", {
 *   name: "nginx",
 *   tag: "alpine",
 *   targetName: "acme/nginx",
 *   targetTag: "alpine",
 *   registry: {
 *     server: "ghcr.io",
 *     username: "octocat",
 *     password: Config.redacted("GITHUB_TOKEN"),
 *   },
 * });
 * ```
 */
export const RemoteImage = Resource<RemoteImage>("Docker.RemoteImage");

export const RemoteImageProvider = () =>
  Provider.effect(
    RemoteImage,
    Effect.gen(function* () {
      const docker = yield* Docker;

      return RemoteImage.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ olds, output }) {
          const ref = output?.imageRef ?? targetImageRef(olds);
          return yield* docker.image.inspect(ref).pipe(
            Effect.map((image) => ({
              imageRef: ref,
              imageId: image.Id,
              createdAt: output?.createdAt ?? parseCreatedAt(image.Created),
              name: output?.name ?? repositoryFromImageRef(ref),
              tag: output?.tag ?? targetTag(olds),
              repoDigest: output?.repoDigest,
            })),
            Effect.catchReason(
              "PlatformError",
              "NotFound",
              () => Effect.undefined,
            ),
          );
        }),
        diff: Effect.fn(function* ({ output, news }) {
          if (!isResolved(news)) return undefined;
          if (
            !output ||
            news.alwaysPull !== false ||
            output.imageRef !== targetImageRef(news)
          ) {
            return { action: "update" };
          }
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const sourceRef = remoteImageRef(news);
          yield* session.note(`Pulling Docker image: ${sourceRef}`);
          yield* docker.image.pull(sourceRef, news.platform);

          const finalRef = targetImageRef(news);
          if (finalRef !== sourceRef) {
            yield* session.note(
              `Tagging Docker image: ${sourceRef} -> ${finalRef}`,
            );
            yield* docker.image.tag(sourceRef, finalRef);
          }

          let repoDigest: string | undefined;
          if (news.registry && !news.skipPush) {
            yield* session.note(
              `Pushing image to registry "${news.registry.server}"`,
            );
            repoDigest = yield* docker.image
              .push(finalRef, news.registry)
              .pipe(
                Effect.map((result) =>
                  parseRepoDigest(finalRef, result.stdout),
                ),
              );
          }

          const inspected = yield* docker.image.inspect(finalRef);
          return {
            imageRef: finalRef,
            imageId: inspected.Id,
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

const targetTag = (props: RemoteImageProps): string =>
  props.targetTag ?? props.tag ?? "latest";

/**
 * The final reference after re-tagging and registry-host prefixing. Equals the
 * pulled reference when no re-tag/registry is configured.
 */
const targetImageRef = (props: RemoteImageProps): string => {
  const local = `${props.targetName ?? props.name}:${targetTag(props)}`;
  return props.registry && !props.skipPush
    ? withRegistryHost(local, props.registry)
    : local;
};

import * as ecr from "@distilled.cloud/aws/ecr";
import * as Effect from "effect/Effect";
import {
  makeContainerImageSource,
  type ImageRegistryTarget,
  type ImageSourceLike,
} from "../../Docker/ImageSource.ts";
import { getEcrRegistryCredentials } from "./Image.ts";

/**
 * INTERNAL — the ECR target for the shared container image-source machinery
 * ([Docker/ImageSource.ts](../../Docker/ImageSource.ts)), used by the AWS
 * container platforms (`AWS.ECS.Task`, `AWS.ECS.Service`, `AWS.EKS.*`).
 *
 * NOT exported from the AWS barrel or `ECR/index.ts`. Consumers import the
 * module path directly.
 *
 * Every source lands in an auto-created (caller-named) private ECR
 * repository so the compute platform pulls from a registry that is reliable
 * from private VPCs and IAM-authenticated.
 */

export {
  computeStaticSourceHash,
  imageSourceKind,
  validateImageSource,
  type BundledImageSource,
  type DockerfileImageSource,
  type ImageSourceKind,
  type ImageSourceLike,
  type ImageSourceProps,
  type RegistryImageSource,
} from "../../Docker/ImageSource.ts";

/** The resolved (built/mirrored + pushed) image. */
export interface ResolvedImage {
  /** Full image reference, `<repositoryUri>:<codeHash>`. */
  imageUri: string;
  /** Name of the ECR repository the image was pushed to. */
  repositoryName: string;
  /** URI of the ECR repository the image was pushed to. */
  repositoryUri: string;
  /** Content hash identifying the image (also the image tag). */
  codeHash: string;
}

export interface ResolveImageOptions {
  /** Logical resource id — keys the stable build-context directory. */
  id: string;
  /**
   * The props bag carrying the image source fields (`main` / `context` /
   * `image` plus their modifiers).
   */
  source: ImageSourceLike;
  /** Name of the ECR repository to (auto-create and) push into. */
  repositoryName: string;
  /**
   * Known repository URI (from prior Attributes). When provided, repository
   * creation is skipped.
   */
  repositoryUri?: string;
  /** Tags applied to the auto-created repository. */
  tags?: Record<string, string>;
  /**
   * Target image platform.
   * @default "linux/amd64"
   */
  platform?: string;
  /**
   * Port the generated Dockerfile should `ENV PORT=` + `EXPOSE`
   * (`main` source only).
   */
  port?: number;
  /**
   * True when the resource was declared without an inline Effect impl —
   * `main` is then bundled as-is without the virtual-entry bootstrap.
   */
  isExternal?: boolean;
  /**
   * The virtual-entry bootstrap wrapped around `main` for Effect-native
   * programs: receives the resolved entry import path and returns the
   * generated entry module source. Platform-specific (server vs one-shot
   * differ per platform), so the caller supplies it.
   */
  bootstrap: (importPath: string) => string;
  /** Plan-status session used to emit build/push progress notes. */
  session: { note: (message: string) => Effect.Effect<void> };
}

/**
 * The generated entry for `AWS.ECS.Task` / `AWS.ECS.Service` containers: a
 * shim importing only `alchemy/Runtime/Bootstrap/Ecs` (resolvable from any
 * consumer — `alchemy` is its direct dependency) plus the user's `main`.
 * Everything the runtime needs lives in that real module, so the virtual
 * entry never imports alchemy's own dependencies (`@distilled.cloud/*`,
 * `@effect/platform-bun`), which an isolated install cannot resolve from
 * the consumer's project.
 */
export const makeBunBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "alchemy/Runtime/Bootstrap/Ecs";
import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

await bootstrap(entrypoint);
`;

/**
 * Init-time constructor for the ECR image-source resolver: the shared
 * container image pipeline pushing into an auto-created ECR repository.
 */
export const makeImageSource = Effect.gen(function* () {
  const images = yield* makeContainerImageSource;

  /**
   * Ensure the target ECR repository exists. Idempotent: tolerates
   * `RepositoryAlreadyExistsException` as a race / re-run and re-describes.
   */
  const ensureRepository = Effect.fn(function* (options: {
    repositoryName: string;
    tags?: Record<string, string>;
  }) {
    const created = yield* ecr
      .createRepository({
        repositoryName: options.repositoryName,
        imageTagMutability: "MUTABLE",
        imageScanningConfiguration: {
          scanOnPush: true,
        },
        tags: Object.entries(options.tags ?? {}).map(([Key, Value]) => ({
          Key,
          Value,
        })),
      })
      .pipe(
        Effect.catchTag("RepositoryAlreadyExistsException", () =>
          Effect.gen(function* () {
            const existing = yield* ecr.describeRepositories({
              repositoryNames: [options.repositoryName],
            });
            return {
              repository: existing.repositories?.[0],
            };
          }),
        ),
      );
    const repository = created.repository;
    if (!repository?.repositoryUri) {
      return yield* Effect.die(
        new Error(
          `Failed to resolve ECR repository '${options.repositoryName}'`,
        ),
      );
    }
    return repository.repositoryUri;
  });

  /** Observe a pushed tag in ECR. Missing repository or tag → false. */
  const hasTag = (repositoryName: string) =>
    Effect.fn(function* (imageTag: string) {
      const described = yield* ecr
        .describeImages({
          repositoryName,
          imageIds: [{ imageTag }],
        })
        .pipe(
          Effect.catchTag(
            ["ImageNotFoundException", "RepositoryNotFoundException"],
            () => Effect.succeed(undefined),
          ),
        );
      return described?.imageDetails?.[0] !== undefined;
    });

  /**
   * Resolve the image for a props bag: ensure the repository, compute the
   * content-addressed tag, then build/mirror + push only when that exact
   * tag is not already in ECR (crash-safe convergence).
   */
  const resolve = Effect.fn(function* (options: ResolveImageOptions) {
    const target = {
      repositoryUri:
        options.repositoryUri !== undefined
          ? Effect.succeed(options.repositoryUri)
          : ensureRepository({
              repositoryName: options.repositoryName,
              tags: options.tags,
            }),
      hasTag: hasTag(options.repositoryName),
      credentials: getEcrRegistryCredentials,
    } satisfies ImageRegistryTarget<any>;
    const resolved = yield* images.resolve(options, target);
    return {
      imageUri: resolved.imageUri,
      repositoryName: options.repositoryName,
      repositoryUri: resolved.repositoryUri,
      codeHash: resolved.codeHash,
    } satisfies ResolvedImage;
  });

  return { resolve, hash: images.hash, watchMain: images.watchMain };
});

/** The resolver service returned by {@link makeImageSource}. */
export interface ImageSource extends Effect.Success<typeof makeImageSource> {}

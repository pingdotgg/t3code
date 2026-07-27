import * as ecr from "@distilled.cloud/aws/ecr";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as crypto from "node:crypto";
import { isResolved } from "../../Diff.ts";
import { Docker } from "../../Docker/Docker.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * Docker login credentials for the account's private ECR registry, in the
 * shape `Docker.image.push` expects. The password is the decoded ECR bearer
 * token — a credential — so it is carried as `Redacted` and only unwrapped
 * inside `docker push`'s ephemeral auth config.
 */
export interface EcrRegistryCredentials {
  username: string;
  password: Redacted.Redacted<string>;
  server: string;
}

/**
 * Resolves Docker login credentials for the account's private ECR registry
 * by decoding `ecr.getAuthorizationToken`.
 */
export const getEcrRegistryCredentials = Effect.gen(function* () {
  const auth = yield* ecr.getAuthorizationToken({});
  const authData = auth.authorizationData?.[0];
  const token = authData?.authorizationToken;
  const proxyEndpoint = authData?.proxyEndpoint;
  if (!token || !proxyEndpoint) {
    return yield* Effect.die(
      new Error("Failed to get ECR authorization token"),
    );
  }
  const password = yield* Effect.sync(() => {
    const raw = Redacted.isRedacted(token) ? Redacted.value(token) : token;
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const [, secret] = decoded.split(":", 2);
    return Redacted.make(secret);
  });
  return {
    username: "AWS",
    password,
    server: proxyEndpoint.replace(/^https?:\/\//, ""),
  } satisfies EcrRegistryCredentials;
});

/**
 * Builds a Docker image from a local context and pushes it to the account's
 * private ECR registry. Shared by the `ECR.Image` provider and the
 * `ECS.Task` runtime resource (which materializes a generated Dockerfile
 * into its bundle context before delegating here).
 */
export const buildAndPushEcrImage = Effect.fn(function* (
  docker: Docker["Service"],
  options: {
    /** Full image reference to build and push, e.g. `<repositoryUri>:<tag>`. */
    imageUri: string;
    /** Docker build context directory. */
    context: string;
    /** Absolute path to the Dockerfile. Defaults to `Dockerfile` in `context`. */
    dockerfile?: string;
    /** Target platform, e.g. `"linux/amd64"`. */
    platform?: string;
    /** Docker build arguments. */
    buildArgs?: Record<string, string>;
  },
) {
  const credentials = yield* getEcrRegistryCredentials;
  yield* docker.image.build({
    tag: options.imageUri,
    context: options.context,
    file: options.dockerfile,
    platform: options.platform,
    "build-arg": options.buildArgs,
  });
  yield* docker.image.push(options.imageUri, credentials);
  return options.imageUri;
});

export interface ImageProps {
  /**
   * URI of the target ECR repository, e.g. `repository.repositoryUri` from an
   * `ECR.Repository`. When omitted, the Image auto-creates (and owns) a
   * repository whose name is derived from the logical id; the owned
   * repository is force-deleted when the Image is destroyed.
   */
  repositoryUri?: string;
  /**
   * Docker build context directory. Every file under the context (plus the
   * Dockerfile, platform, and build args) participates in the content hash
   * that identifies the image — the image is rebuilt and pushed only when
   * that hash changes.
   */
  context: string;
  /**
   * Path to the Dockerfile, relative to `context` unless absolute.
   * @default "Dockerfile"
   */
  dockerfile?: string;
  /**
   * Target platform for the image build. Fargate defaults to X86_64, so the
   * default pins `linux/amd64` — without it an image built on an ARM64 host
   * (e.g. Apple Silicon) is rejected at task start.
   * @default "linux/amd64"
   */
  platform?: string;
  /**
   * Docker build arguments (`--build-arg`).
   */
  buildArgs?: Record<string, string>;
}

export interface Image extends Resource<
  "AWS.ECR.Image",
  ImageProps,
  {
    /** Full image reference, `<repositoryUri>:<imageTag>`. */
    imageUri: string;
    /** Registry manifest digest, e.g. `sha256:...`. */
    digest: string;
    /** URI of the repository the image was pushed to. */
    repositoryUri: string;
    /** Name of the repository the image was pushed to. */
    repositoryName: string;
    /** Content-hash tag the image was pushed under. */
    imageTag: string;
    /** Whether this Image auto-created (and owns) the backing repository. */
    ownsRepository: boolean;
  },
  never,
  Providers
> {}

/**
 * A Docker image built from a local context and pushed to a private Amazon
 * ECR repository.
 *
 * The image is identified by a content hash over the build context,
 * Dockerfile, platform, and build args. Reconcile rebuilds and pushes only
 * when that hash changes — a content change produces a new tag and digest on
 * the same resource, so replacement is never needed.
 *
 * @resource
 * @section Building Images
 * @example Push to an ECR Repository
 * ```typescript
 * const repository = yield* AWS.ECR.Repository("AppRepository", {});
 * const image = yield* AWS.ECR.Image("AppImage", {
 *   repositoryUri: repository.repositoryUri,
 *   context: "./app",
 * });
 * ```
 *
 * @example Auto-created Repository
 * ```typescript
 * const image = yield* AWS.ECR.Image("AppImage", {
 *   context: "./app",
 * });
 * ```
 *
 * @section Build Configuration
 * @example Custom Dockerfile, Platform, and Build Args
 * ```typescript
 * const image = yield* AWS.ECR.Image("WorkerImage", {
 *   repositoryUri: repository.repositoryUri,
 *   context: "./worker",
 *   dockerfile: "Dockerfile.worker",
 *   platform: "linux/arm64",
 *   buildArgs: { NODE_ENV: "production" },
 * });
 * ```
 *
 * @section Consuming the Image
 * @example Reference from a Task Definition
 * ```typescript
 * const task = yield* AWS.ECS.Task("ApiTask", {
 *   main: import.meta.url,
 *   sidecars: [{ name: "proxy", image: image.imageUri, essential: false }],
 * });
 * ```
 */
export const Image = Resource<Image>("AWS.ECR.Image");

/** Derives the repository name from a repository URI (`<registry>/<name>`). */
const repositoryNameFromUri = (repositoryUri: string) =>
  repositoryUri.split("/").slice(1).join("/");

export const ImageProvider = () =>
  Provider.effect(
    Image,
    Effect.gen(function* () {
      const docker = yield* Docker;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const toOwnedRepositoryName = (id: string) =>
        createPhysicalName({
          id,
          maxLength: 256,
          lowercase: true,
        });

      const resolveBuildPaths = Effect.fn(function* (props: ImageProps) {
        const context = path.resolve(props.context);
        const dockerfile = props.dockerfile
          ? path.isAbsolute(props.dockerfile)
            ? props.dockerfile
            : path.resolve(context, props.dockerfile)
          : path.resolve(context, "Dockerfile");
        if (!(yield* fs.exists(context))) {
          return yield* Effect.fail(
            new Error(`Docker build context does not exist: ${context}`),
          );
        }
        if (!(yield* fs.exists(dockerfile))) {
          return yield* Effect.fail(
            new Error(`Dockerfile does not exist: ${dockerfile}`),
          );
        }
        return { context, dockerfile };
      });

      // Content hash over everything that affects the built image: the
      // Dockerfile, every file in the build context (relative path + bytes),
      // the target platform, and the build args. Absolute paths deliberately
      // do NOT participate, so relocating an identical context (e.g. a temp
      // dir) produces the same tag.
      const hashBuildInputs = Effect.fn(function* (props: ImageProps) {
        const { context, dockerfile } = yield* resolveBuildPaths(props);
        const hasher = yield* Effect.sync(() => crypto.createHash("sha256"));
        yield* Effect.sync(() =>
          hasher.update(
            JSON.stringify({
              platform: props.platform ?? "linux/amd64",
              buildArgs: Object.entries(props.buildArgs ?? {}).sort(
                ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
              ),
            }),
          ),
        );
        const dockerfileContent = yield* fs.readFile(dockerfile);
        yield* Effect.sync(() => {
          hasher.update("Dockerfile\0");
          hasher.update(dockerfileContent);
        });
        const entries = yield* fs.readDirectory(context, { recursive: true });
        for (const entry of [...entries].sort()) {
          const full = path.join(context, entry);
          const info = yield* fs.stat(full);
          if (info.type !== "File") continue;
          const content = yield* fs.readFile(full);
          yield* Effect.sync(() => {
            hasher.update(`${entry}\0`);
            hasher.update(content);
          });
        }
        return (yield* Effect.sync(() => hasher.digest("hex"))).slice(0, 32);
      });

      // Observe the pushed image in ECR. Missing repository or tag → undefined.
      const describeImage = Effect.fn(function* (
        repositoryName: string,
        imageTag: string,
      ) {
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
        return described?.imageDetails?.[0];
      });

      // Ensure the auto-created repository exists. Idempotent: tolerates
      // `RepositoryAlreadyExistsException` as a race / re-run and re-describes.
      const ensureOwnedRepository = Effect.fn(function* (
        id: string,
        repositoryName: string,
      ) {
        const internalTags = yield* createInternalTags(id);
        const created = yield* ecr
          .createRepository({
            repositoryName,
            imageTagMutability: "MUTABLE",
            tags: Object.entries(internalTags).map(([Key, Value]) => ({
              Key,
              Value,
            })),
          })
          .pipe(
            Effect.catchTag("RepositoryAlreadyExistsException", () =>
              ecr
                .describeRepositories({ repositoryNames: [repositoryName] })
                .pipe(
                  Effect.map((res) => ({ repository: res.repositories?.[0] })),
                ),
            ),
          );
        const repositoryUri = created.repository?.repositoryUri;
        if (!repositoryUri) {
          return yield* Effect.fail(
            new Error(
              `Failed to create or read ECR repository '${repositoryName}'`,
            ),
          );
        }
        return repositoryUri;
      });

      return {
        read: Effect.fn(function* ({ output }) {
          // The content hash cannot be recovered without running a build, so
          // a lost-state read has nothing to look up.
          if (!output) return undefined;
          const detail = yield* describeImage(
            output.repositoryName,
            output.imageTag,
          );
          if (!detail?.imageDigest) return undefined;
          return { ...output, digest: detail.imageDigest };
        }),
        // Content changes don't change Props (the context path stays the
        // same while the files under it change), so surface them here: hash
        // the build inputs and request an update when the hash drifts from
        // the pushed tag. Replacement is never needed — a new hash is just a
        // new tag + digest on the same resource.
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const hash = yield* hashBuildInputs(news);
          if (hash !== output.imageTag) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // Resolve the target repository: user-supplied URI, or an
          // auto-created repository owned by this Image.
          const { repositoryName, repositoryUri, ownsRepository } =
            yield* Effect.gen(function* () {
              if (news.repositoryUri) {
                return {
                  repositoryName: repositoryNameFromUri(news.repositoryUri),
                  repositoryUri: news.repositoryUri,
                  ownsRepository: false,
                };
              }
              const repositoryName = output?.ownsRepository
                ? output.repositoryName
                : yield* toOwnedRepositoryName(id);
              const repositoryUri = yield* ensureOwnedRepository(
                id,
                repositoryName,
              );
              return { repositoryName, repositoryUri, ownsRepository: true };
            });

          const { context, dockerfile } = yield* resolveBuildPaths(news);
          const imageTag = yield* hashBuildInputs(news);
          const imageUri = `${repositoryUri}:${imageTag}`;

          // Observe — if this exact content hash is already pushed, there is
          // nothing to build (crash-safe: a re-run after a mid-reconcile
          // failure converges without a rebuild).
          const observed = yield* describeImage(repositoryName, imageTag);
          if (observed?.imageDigest) {
            yield* session.note(imageUri);
            return {
              imageUri,
              digest: observed.imageDigest,
              repositoryUri,
              repositoryName,
              imageTag,
              ownsRepository,
            };
          }

          yield* session.note(`building ${imageUri}`);
          yield* buildAndPushEcrImage(docker, {
            imageUri,
            context,
            dockerfile,
            platform: news.platform ?? "linux/amd64",
            buildArgs: news.buildArgs,
          });

          const pushed = yield* describeImage(repositoryName, imageTag);
          if (!pushed?.imageDigest) {
            return yield* Effect.fail(
              new Error(`Image ${imageUri} not found in ECR after push`),
            );
          }
          yield* session.note(imageUri);
          return {
            imageUri,
            digest: pushed.imageDigest,
            repositoryUri,
            repositoryName,
            imageTag,
            ownsRepository,
          };
        }),
        // Enumerate every tagged image across every repository in the
        // account/region. Repository ownership is recorded per-instance in
        // state and cannot be recovered from enumeration, so listed items are
        // conservatively marked `ownsRepository: false` — orphan deletion
        // removes the tag but leaves the repository (ECR.Repository's own
        // list()/delete() covers repositories).
        list: () =>
          Effect.gen(function* () {
            const repositories = yield* ecr.describeRepositories.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.repositories ?? []),
              ),
            );
            const nested = yield* Effect.forEach(
              repositories.filter(
                (
                  r,
                ): r is ecr.Repository & {
                  repositoryName: string;
                  repositoryUri: string;
                } => r.repositoryName != null && r.repositoryUri != null,
              ),
              (repository) =>
                ecr.describeImages
                  .pages({ repositoryName: repository.repositoryName })
                  .pipe(
                    Stream.runCollect,
                    Effect.map((chunk) =>
                      Array.from(chunk).flatMap(
                        (page) => page.imageDetails ?? [],
                      ),
                    ),
                    Effect.map((details) =>
                      details.flatMap((detail) =>
                        detail.imageDigest === undefined
                          ? []
                          : (detail.imageTags ?? []).map((imageTag) => ({
                              imageUri: `${repository.repositoryUri}:${imageTag}`,
                              digest: detail.imageDigest!,
                              repositoryUri: repository.repositoryUri,
                              repositoryName: repository.repositoryName,
                              imageTag,
                              ownsRepository: false,
                            })),
                      ),
                    ),
                    // Repository deleted between the list and the describe.
                    Effect.catchTag("RepositoryNotFoundException", () =>
                      Effect.succeed([]),
                    ),
                  ),
              { concurrency: 10 },
            );
            return nested.flat();
          }),
        delete: Effect.fn(function* ({ output }) {
          if (output.ownsRepository) {
            yield* ecr
              .deleteRepository({
                repositoryName: output.repositoryName,
                force: true,
              })
              .pipe(
                Effect.catchTag(
                  "RepositoryNotFoundException",
                  () => Effect.void,
                ),
              );
            return;
          }
          // Foreign repository: delete only our tag. `batchDeleteImage`
          // reports a missing image via its `failures` array (not an error),
          // so this is naturally idempotent.
          yield* ecr
            .batchDeleteImage({
              repositoryName: output.repositoryName,
              imageIds: [{ imageTag: output.imageTag }],
            })
            .pipe(
              Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

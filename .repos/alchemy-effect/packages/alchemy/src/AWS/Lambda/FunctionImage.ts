import * as ecr from "@distilled.cloud/aws/ecr";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Docker } from "../../Docker/Docker.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
} from "../../Tags.ts";
import { sha256Object } from "../../Util/sha256.ts";
import {
  hashDockerBuildInputs,
  resolveDockerBuildPaths,
} from "../../Docker/BuildHash.ts";
import { buildAndPushEcrImage } from "../ECR/Image.ts";
import { AWSEnvironment } from "../Environment.ts";
import { normalizePolicyDocument } from "../IAM/Policy.ts";
import type { FunctionImageConfig } from "./Function.ts";

/** A Lambda container image built from a local Docker context. */
export interface FunctionDockerImageSource extends FunctionImageConfig {
  uri?: never;
  /** Docker build context directory. */
  context: string;
  /** Dockerfile path, relative to {@link context} unless absolute. */
  dockerfile: string;
  /**
   * Docker build arguments (`--build-arg`).
   *
   * Build arguments are stored in deployment state and may be retained in
   * image layers. Do not use them for secrets.
   */
  buildArgs?: Record<string, string>;
}

/** An existing private ECR image, addressed by tag or immutable digest. */
export interface FunctionEcrImageSource extends FunctionImageConfig {
  /**
   * Full private ECR image URI, including a tag or digest.
   *
   * The repository must be in the same AWS Region as the Lambda function.
   * Alchemy observes the current ECR digest on every plan, so repointing a
   * tag updates the function even when the URI string itself is unchanged.
   */
  uri: string;
  context?: never;
  dockerfile?: never;
  buildArgs?: never;
}

/**
 * Image input for an image-packaged Lambda function.
 *
 * Source values must be literal because Lambda's circular-dependency
 * pre-create phase needs the deployable image before normal Output resolution.
 */
export type FunctionImageSource =
  | FunctionDockerImageSource
  | FunctionEcrImageSource;

// Instruction overrides ride along on the source object; they are function
// configuration, not image identity, so they never enter the image hash.
const FunctionImageConfigFields = {
  command: Schema.optionalKey(Schema.Array(Schema.String)),
  entryPoint: Schema.optionalKey(Schema.Array(Schema.String)),
  workingDirectory: Schema.optionalKey(Schema.String),
};

const FunctionDockerImageSourceSchema = Schema.Struct({
  context: Schema.String,
  dockerfile: Schema.String,
  buildArgs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  ...FunctionImageConfigFields,
}) satisfies Schema.Schema<FunctionDockerImageSource>;

const FunctionEcrImageSourceSchema = Schema.Struct({
  uri: Schema.String,
  ...FunctionImageConfigFields,
}) satisfies Schema.Schema<FunctionEcrImageSource>;

const FunctionImageSourceRecordSchema = Schema.Record(
  Schema.String,
  Schema.Unknown,
);

export interface ParsedFunctionImageUri {
  uri: string;
  registryId: string;
  registryHost: string;
  region: string;
  repositoryName: string;
  repositoryUri: string;
  imageId: { imageTag: string } | { imageDigest: string };
}

/** Parse and validate a tagged or digest-pinned private ECR image URI. */
export const parseFunctionImageUri = Effect.fn("AWS.Lambda.parseImageUri")(
  function* (id: string, uri: string) {
    const slash = uri.indexOf("/");
    if (slash <= 0 || slash === uri.length - 1) {
      return yield* Effect.fail(
        new Error(
          `Function(${id}): image.uri must be a private ECR image URI including a tag or digest`,
        ),
      );
    }

    const registryHost = uri.slice(0, slash);
    const registry = /^(\d{12})\.dkr\.ecr(-fips)?\.([a-z0-9-]+)\.(.+)$/.exec(
      registryHost,
    );
    if (registry === null) {
      return yield* Effect.fail(
        new Error(
          `Function(${id}): image.uri must use a private ECR registry such as 123456789012.dkr.ecr.us-east-1.amazonaws.com/repository:tag`,
        ),
      );
    }
    if (registry[2] !== undefined) {
      return yield* Effect.fail(
        new Error(
          `Function(${id}): Lambda container images do not support ECR FIPS endpoints`,
        ),
      );
    }

    const reference = uri.slice(slash + 1);
    const digestSeparator = reference.lastIndexOf("@");
    const tagSeparator = reference.lastIndexOf(
      ":",
      digestSeparator >= 0 ? digestSeparator : reference.length,
    );
    if (digestSeparator >= 0 && tagSeparator >= 0) {
      return yield* Effect.fail(
        new Error(
          `Function(${id}): image.uri must identify the image by either tag or digest, not both`,
        ),
      );
    }
    const repositoryName = reference.slice(
      0,
      digestSeparator >= 0 ? digestSeparator : tagSeparator,
    );
    if (repositoryName.length === 0) {
      return yield* Effect.fail(
        new Error(`Function(${id}): image.uri has no ECR repository name`),
      );
    }

    const imageId = yield* Effect.gen(function* () {
      if (digestSeparator >= 0) {
        const imageDigest = reference.slice(digestSeparator + 1);
        if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
          return yield* Effect.fail(
            new Error(
              `Function(${id}): image.uri digest must be sha256 followed by 64 lowercase hexadecimal characters`,
            ),
          );
        }
        return { imageDigest } as const;
      }
      if (tagSeparator <= 0 || tagSeparator === reference.length - 1) {
        return yield* Effect.fail(
          new Error(
            `Function(${id}): image.uri must include an explicit ECR tag or digest`,
          ),
        );
      }
      return { imageTag: reference.slice(tagSeparator + 1) } as const;
    });

    return {
      uri,
      registryId: registry[1],
      registryHost,
      region: registry[3],
      repositoryName,
      repositoryUri: `${registryHost}/${repositoryName}`,
      imageId,
    } satisfies ParsedFunctionImageUri;
  },
);

export interface FunctionImageAttributes {
  /** Image source kind used by the Function. */
  source: "build" | "uri";
  /** Stable identity hash for the requested URI and resolved image digest. */
  hash: string;
  /** Tag- or digest-based URI passed to Lambda. */
  imageUri: string;
  /** Digest-pinned URI resolved from ECR. */
  resolvedImageUri: string;
  /** Registry manifest digest. */
  digest: string;
  /** Backing ECR repository name. */
  repositoryName: string;
  /** Backing ECR repository URI. */
  repositoryUri: string;
  /** Whether the Function owns and may delete the backing repository. */
  ownsRepository: boolean;
}

export interface ResolveFunctionImageOptions {
  id: string;
  source: FunctionImageSource;
  architecture: "x86_64" | "arm64";
  previousImage?: Omit<FunctionImageAttributes, "hash">;
  session: { note: (message: string) => Effect.Effect<void> };
}

export interface FunctionImageIdentity {
  source: "build" | "uri";
  hash: string;
  imageUri?: string;
  resolvedImageUri?: string;
}

/**
 * Increment when the Lambda image build behavior changes in a way that must
 * invalidate already-pushed content-addressed images.
 */
const functionImageBuilderVersion = 2;

export const functionImagePlatform = (architecture: "x86_64" | "arm64") => {
  if (architecture === "x86_64") {
    return "linux/amd64";
  }
  if (architecture === "arm64") {
    return "linux/arm64";
  }
  throw new Error(`Unsupported Lambda image architecture: ${architecture}`);
};

const hashDecodedFunctionImageBuild = Effect.fn(function* (
  source: FunctionDockerImageSource,
  architecture: "x86_64" | "arm64",
) {
  const buildHash = yield* hashDockerBuildInputs(
    {
      ...source,
      platform: functionImagePlatform(architecture),
    },
    "effective",
  );
  return (yield* sha256Object({
    builderVersion: functionImageBuilderVersion,
    buildHash,
  })).slice(0, 32);
});

/**
 * Hash the Docker build context, Dockerfile, build args, target platform, and
 * Lambda image-builder version without including absolute paths.
 */
export const hashFunctionImageBuild = Effect.fn(function* (
  source: FunctionDockerImageSource,
  architecture: "x86_64" | "arm64",
) {
  const decoded = yield* Schema.decodeUnknownEffect(
    FunctionDockerImageSourceSchema,
  )(source);
  return yield* hashDecodedFunctionImageBuild(decoded, architecture);
});

export const decodeFunctionImageSource = Effect.fn(
  "AWS.Lambda.decodeFunctionImageSource",
)(function* (id: string, source: unknown) {
  const record = yield* Schema.decodeUnknownEffect(
    FunctionImageSourceRecordSchema,
  )(source).pipe(
    Effect.mapError(
      (error) =>
        new Error(`Function(${id}): image must be an object`, { cause: error }),
    ),
  );
  const hasUri = record.uri !== undefined;
  const hasBuildSource =
    record.context !== undefined ||
    record.dockerfile !== undefined ||
    record.buildArgs !== undefined;
  if (hasUri && hasBuildSource) {
    return yield* Effect.fail(
      new Error(
        `Function(${id}): image.uri cannot be combined with image.context, image.dockerfile, or image.buildArgs; declare exactly one image source`,
      ),
    );
  }
  if (!hasUri && !hasBuildSource) {
    return yield* Effect.fail(
      new Error(
        `Function(${id}): image must declare either image.uri or both image.context and image.dockerfile`,
      ),
    );
  }
  const decodeError = (error: unknown) =>
    new Error(
      `Function(${id}): image source values must be literal and valid before Lambda pre-create`,
      { cause: error },
    );
  if (hasUri) {
    return yield* Schema.decodeUnknownEffect(FunctionEcrImageSourceSchema)(
      source,
    ).pipe(
      Effect.map((decoded): FunctionEcrImageSource => decoded),
      Effect.mapError(decodeError),
    );
  }
  return yield* Schema.decodeUnknownEffect(FunctionDockerImageSourceSchema)(
    source,
  ).pipe(
    Effect.map((decoded): FunctionDockerImageSource => decoded),
    Effect.mapError(decodeError),
  );
});

const isFunctionEcrImageSource = (
  source: FunctionImageSource,
): source is FunctionEcrImageSource => source.uri !== undefined;

/**
 * Lambda-specific image resolver. It deliberately stays separate from the
 * ECS/EKS image-source abstraction because Lambda deploys private ECR images
 * directly and its managed local-build path owns a repository pull policy.
 */
export const makeFunctionImage = Effect.gen(function* () {
  const docker = yield* Docker;

  const createRepositoryName = (id: string) =>
    createPhysicalName({
      id: `${id}-image`,
      maxLength: 256,
      lowercase: true,
    });

  const desiredRepositoryPolicy = Effect.fn(function* () {
    const { accountId, region } = yield* AWSEnvironment.current;
    return JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "LambdaECRImageRetrievalPolicy",
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
          Condition: {
            StringLike: {
              "aws:sourceArn": `arn:aws:lambda:${region}:${accountId}:function:*`,
            },
          },
        },
      ],
    });
  });

  const ensureRepository = Effect.fn(function* (
    id: string,
    repositoryName: string,
  ) {
    let repository = yield* ecr
      .describeRepositories({ repositoryNames: [repositoryName] })
      .pipe(
        Effect.map((response) => response.repositories?.[0]),
        Effect.catchTag("RepositoryNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      );

    if (!repository?.repositoryArn || !repository.repositoryUri) {
      const tags = yield* createInternalTags(id);
      repository = yield* ecr
        .createRepository({
          repositoryName,
          imageTagMutability: "IMMUTABLE",
          imageScanningConfiguration: { scanOnPush: true },
          tags: createTagsList(tags),
        })
        .pipe(
          Effect.map((response) => response.repository),
          Effect.catchTag("RepositoryAlreadyExistsException", () =>
            ecr
              .describeRepositories({ repositoryNames: [repositoryName] })
              .pipe(Effect.map((response) => response.repositories?.[0])),
          ),
        );
    }

    if (!repository?.repositoryArn || !repository.repositoryUri) {
      return yield* Effect.die(
        new Error(
          `Failed to create or read Lambda image repository '${repositoryName}'`,
        ),
      );
    }

    const tags = yield* ecr.listTagsForResource({
      resourceArn: repository.repositoryArn,
    });
    if (!(yield* hasAlchemyTags(id, tags.tags))) {
      return yield* Effect.die(
        new Error(
          `Lambda image repository '${repositoryName}' exists but is not owned by Function(${id})`,
        ),
      );
    }

    // Tags are content hashes, so changing what an existing tag references
    // would violate the identity contract used by Lambda deployment state.
    // Verify ownership before migrating repositories created by older versions.
    if (repository.imageTagMutability !== "IMMUTABLE") {
      yield* ecr.putImageTagMutability({
        repositoryName,
        imageTagMutability: "IMMUTABLE",
      });
    }

    const desiredPolicy = yield* desiredRepositoryPolicy();
    const observedPolicy = yield* ecr
      .getRepositoryPolicy({ repositoryName })
      .pipe(
        Effect.map((response) => response.policyText),
        Effect.catchTag("RepositoryPolicyNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      );
    if (
      observedPolicy === undefined ||
      normalizePolicyDocument(observedPolicy) !==
        normalizePolicyDocument(desiredPolicy)
    ) {
      yield* ecr.setRepositoryPolicy({
        repositoryName,
        policyText: desiredPolicy,
      });
    }

    return {
      repositoryName,
      repositoryUri: repository.repositoryUri,
    };
  });

  const describeImage = Effect.fn(function* (
    repositoryName: string,
    imageTag: string,
  ) {
    const response = yield* ecr
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
    return response?.imageDetails?.[0];
  });

  const resolveExternalImage = Effect.fn("AWS.Lambda.resolveExternalImage")(
    function* (
      id: string,
      source: FunctionEcrImageSource,
      previousImage?: Omit<FunctionImageAttributes, "hash">,
    ) {
      const parsed = yield* parseFunctionImageUri(id, source.uri);
      const { region } = yield* AWSEnvironment.current;
      if (parsed.region !== region) {
        return yield* Effect.fail(
          new Error(
            `Function(${id}): ECR image region '${parsed.region}' must match Lambda region '${region}'`,
          ),
        );
      }

      const detail = yield* ecr
        .describeImages({
          registryId: parsed.registryId,
          repositoryName: parsed.repositoryName,
          imageIds: [parsed.imageId],
        })
        .pipe(
          Effect.catchTag(
            ["ImageNotFoundException", "RepositoryNotFoundException"],
            () =>
              Effect.fail(
                new Error(
                  `Function(${id}): ECR image '${source.uri}' does not exist or is not accessible`,
                ),
              ),
          ),
          Effect.map((response) => response.imageDetails?.[0]),
        );
      const digest = detail?.imageDigest;
      if (digest === undefined) {
        return yield* Effect.fail(
          new Error(
            `Function(${id}): ECR image '${source.uri}' did not resolve to a registry digest`,
          ),
        );
      }

      const hash = (yield* sha256Object({ uri: source.uri, digest })).slice(
        0,
        32,
      );
      return {
        source: "uri",
        hash,
        imageUri: source.uri,
        resolvedImageUri: `${parsed.repositoryUri}@${digest}`,
        digest,
        repositoryName: parsed.repositoryName,
        repositoryUri: parsed.repositoryUri,
        ownsRepository:
          previousImage?.ownsRepository === true &&
          previousImage.repositoryUri === parsed.repositoryUri,
      } satisfies FunctionImageAttributes;
    },
  );

  const identity = Effect.fn(function* (
    id: string,
    source: FunctionImageSource,
    architecture: "x86_64" | "arm64",
  ) {
    const decoded = yield* decodeFunctionImageSource(id, source);
    if (isFunctionEcrImageSource(decoded)) {
      const external = yield* resolveExternalImage(id, decoded);
      return {
        source: external.source,
        hash: external.hash,
        imageUri: external.imageUri,
        resolvedImageUri: external.resolvedImageUri,
      } satisfies FunctionImageIdentity;
    }
    return {
      source: "build",
      hash: yield* hashDecodedFunctionImageBuild(decoded, architecture),
    } satisfies FunctionImageIdentity;
  });

  const hash = Effect.fn(function* (
    id: string,
    source: FunctionImageSource,
    architecture: "x86_64" | "arm64",
  ) {
    return (yield* identity(id, source, architecture)).hash;
  });

  const resolve = Effect.fn(function* (options: ResolveFunctionImageOptions) {
    const source = yield* decodeFunctionImageSource(options.id, options.source);
    if (isFunctionEcrImageSource(source)) {
      const image = yield* resolveExternalImage(
        options.id,
        source,
        options.previousImage,
      );
      yield* options.session.note(image.imageUri);
      return image;
    }
    const imageTag = yield* hashDecodedFunctionImageBuild(
      source,
      options.architecture,
    );
    const repositoryName =
      options.previousImage?.ownsRepository === true
        ? options.previousImage.repositoryName
        : yield* createRepositoryName(options.id);
    // Re-ensure even with persisted metadata: the repository or its Lambda
    // pull policy may have drifted out-of-band.
    const ensured = yield* ensureRepository(options.id, repositoryName);
    const imageUri = `${ensured.repositoryUri}:${imageTag}`;

    let detail = yield* describeImage(repositoryName, imageTag);
    if (!detail?.imageDigest) {
      const build = yield* resolveDockerBuildPaths(source);
      yield* options.session.note(`Building Lambda image ${imageUri}...`);
      const pushed = yield* buildAndPushEcrImage(docker, {
        imageUri,
        context: build.context,
        dockerfile: build.dockerfile,
        platform: functionImagePlatform(options.architecture),
        buildArgs: source.buildArgs,
        args: ["--provenance=false"],
      }).pipe(
        Effect.as(true),
        Effect.catch((buildError) =>
          // Two reconcilers can both observe a missing tag and build it. With
          // immutable tags, the second push loses the race. Accept that failure
          // only when ECR proves the desired content-addressed tag now exists.
          describeImage(repositoryName, imageTag).pipe(
            Effect.flatMap((image) =>
              image?.imageDigest !== undefined
                ? Effect.succeed(false)
                : Effect.fail(buildError),
            ),
          ),
        ),
      );
      detail = yield* describeImage(repositoryName, imageTag).pipe(
        Effect.filterOrFail(
          (image) => image?.imageDigest !== undefined,
          () => new Error(`Image ${imageUri} not found in ECR after push`),
        ),
        Effect.retry({
          schedule: Schedule.spaced("1 second"),
          times: 8,
        }),
      );
      yield* options.session.note(
        pushed
          ? `Pushed ${imageUri}`
          : `Reused concurrently pushed ${imageUri}`,
      );
    }

    const digest = detail?.imageDigest;
    if (digest === undefined) {
      return yield* Effect.fail(
        new Error(`Image ${imageUri} has no registry digest after push`),
      );
    }
    return {
      source: "build",
      hash: imageTag,
      imageUri,
      resolvedImageUri: `${ensured.repositoryUri}@${digest}`,
      digest,
      repositoryName,
      repositoryUri: ensured.repositoryUri,
      ownsRepository: true,
    } satisfies FunctionImageAttributes;
  });

  const deleteRepository = (repositoryName: string) =>
    ecr
      .deleteRepository({ repositoryName, force: true })
      .pipe(Effect.catchTag("RepositoryNotFoundException", () => Effect.void));

  const isReady = Effect.fn(function* (
    id: string,
    repositoryName: string,
    imageTag: string,
  ) {
    const repository = yield* ecr
      .describeRepositories({ repositoryNames: [repositoryName] })
      .pipe(
        Effect.map((response) => response.repositories?.[0]),
        Effect.catchTag("RepositoryNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      );
    if (
      repository?.repositoryArn === undefined ||
      repository.repositoryUri === undefined ||
      repository.imageTagMutability !== "IMMUTABLE"
    ) {
      return false;
    }

    const [tags, observedPolicy, image] = yield* Effect.all(
      [
        ecr
          .listTagsForResource({ resourceArn: repository.repositoryArn })
          .pipe(
            Effect.catchTag("RepositoryNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          ),
        ecr.getRepositoryPolicy({ repositoryName }).pipe(
          Effect.map((response) => response.policyText),
          Effect.catchTag(
            [
              "RepositoryNotFoundException",
              "RepositoryPolicyNotFoundException",
            ],
            () => Effect.succeed(undefined),
          ),
        ),
        describeImage(repositoryName, imageTag),
      ] as const,
      { concurrency: 3 },
    );
    if (tags === undefined || !(yield* hasAlchemyTags(id, tags.tags))) {
      return false;
    }

    const desiredPolicy = yield* desiredRepositoryPolicy();
    return (
      observedPolicy !== undefined &&
      normalizePolicyDocument(observedPolicy) ===
        normalizePolicyDocument(desiredPolicy) &&
      image?.imageDigest !== undefined
    );
  });

  return { hash, identity, resolve, isReady, deleteRepository };
});

export interface FunctionImage extends Effect.Success<
  typeof makeFunctionImage
> {}

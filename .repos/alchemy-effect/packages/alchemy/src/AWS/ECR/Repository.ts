import * as ecr from "@distilled.cloud/aws/ecr";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import {
  normalizePolicyDocument,
  stringifyPolicyDocument,
} from "../IAM/Policy.ts";
import type { RegionID } from "../Region.ts";

export type RepositoryName = string;
export type RepositoryArn =
  `arn:aws:ecr:${RegionID}:${AccountID}:repository/${RepositoryName}`;
export type RepositoryUri =
  `${AccountID}.dkr.ecr.${RegionID}.amazonaws.com/${RepositoryName}`;

export interface RepositoryProps {
  /**
   * Name of the repository. If omitted, a unique name is generated.
   */
  repositoryName?: string;
  /**
   * Image tag mutability setting.
   * @default "MUTABLE"
   */
  imageTagMutability?: ecr.ImageTagMutability;
  /**
   * Whether enhanced image scanning should run on push.
   */
  scanOnPush?: boolean;
  /**
   * Optional lifecycle policy document JSON.
   */
  lifecyclePolicyText?: string;
  /**
   * Repository permission policy controlling access from other AWS
   * principals — either a structured IAM {@link PolicyDocument} or a raw
   * JSON string (escape hatch / adoption of an existing policy). Omitting
   * the prop removes any repository policy.
   */
  policy?: PolicyDocument | string;
  /**
   * User-defined tags to apply to the repository.
   */
  tags?: Record<string, string>;
}

export interface Repository extends Resource<
  "AWS.ECR.Repository",
  RepositoryProps,
  {
    /** The name of the repository. */
    repositoryName: RepositoryName;
    /** The ARN of the repository. */
    repositoryArn: RepositoryArn;
    /** The URI used to push/pull images, e.g. `<account>.dkr.ecr.<region>.amazonaws.com/<name>`. */
    repositoryUri: RepositoryUri;
    /** The AWS account ID of the registry. */
    registryId: string;
    /** Whether image tags are `MUTABLE` or `IMMUTABLE`. */
    imageTagMutability: ecr.ImageTagMutability;
    /** The JSON lifecycle policy applied to the repository, if any. */
    lifecyclePolicyText?: string;
    /** The JSON repository permissions policy, if any. */
    policy?: string;
    /** The tags attached to the repository. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon ECR repository for container images.
 * @resource
 * @section Creating Repositories
 * @example Task Image Repository
 * ```typescript
 * const repo = yield* Repository("TaskRepository", {
 *   scanOnPush: true,
 * });
 * ```
 *
 * @section Repository Policies
 * @example Grant Lambda Pull Access
 * ```typescript
 * const repo = yield* Repository("LambdaImages", {
 *   policy: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Sid: "LambdaECRImageRetrieval",
 *         Effect: "Allow",
 *         Principal: { Service: "lambda.amazonaws.com" },
 *         Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const Repository = Resource<Repository>("AWS.ECR.Repository");

export const RepositoryProvider = () =>
  Provider.effect(
    Repository,
    Effect.gen(function* () {
      const toRepositoryName = (
        id: string,
        props: { repositoryName?: string } = {},
      ) =>
        props.repositoryName
          ? Effect.succeed(props.repositoryName)
          : createPhysicalName({
              id,
              maxLength: 256,
              lowercase: true,
            });

      const toPolicyText = (policy: PolicyDocument | string | undefined) =>
        policy === undefined
          ? undefined
          : typeof policy === "string"
            ? policy
            : stringifyPolicyDocument(policy);

      const readPolicy = (repositoryName: string) =>
        ecr.getRepositoryPolicy({ repositoryName }).pipe(
          Effect.map((response) => response.policyText),
          Effect.catchTag(
            [
              "RepositoryPolicyNotFoundException",
              "RepositoryNotFoundException",
            ],
            () => Effect.succeed(undefined),
          ),
        );

      // Sync the repository policy — compare the OBSERVED policy against the
      // desired one via `normalizePolicyDocument` (key order / whitespace
      // insensitive) so a re-deploy of an equivalent document is a no-op.
      const syncPolicy = Effect.fn(function* (
        repositoryName: string,
        desired: string | undefined,
      ) {
        const observed = yield* readPolicy(repositoryName);
        if (desired !== undefined) {
          if (
            observed === undefined ||
            normalizePolicyDocument(observed) !==
              normalizePolicyDocument(desired)
          ) {
            yield* ecr.setRepositoryPolicy({
              repositoryName,
              policyText: desired,
            });
          }
        } else if (observed !== undefined) {
          yield* ecr
            .deleteRepositoryPolicy({ repositoryName })
            .pipe(
              Effect.catchTag(
                "RepositoryPolicyNotFoundException",
                () => Effect.void,
              ),
            );
        }
      });

      return {
        stables: [
          "repositoryArn",
          "repositoryName",
          "repositoryUri",
          "registryId",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toRepositoryName(id, olds ?? {})) !==
            (yield* toRepositoryName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const repositoryName =
            output?.repositoryName ?? (yield* toRepositoryName(id, olds ?? {}));
          const described = yield* ecr
            .describeRepositories({
              repositoryNames: [repositoryName],
            })
            .pipe(
              Effect.catchTag("RepositoryNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const repository = described?.repositories?.[0];
          if (!repository?.repositoryArn || !repository.repositoryUri) {
            return undefined;
          }
          const listedTags = yield* ecr.listTagsForResource({
            resourceArn: repository.repositoryArn,
          });
          const attrs = {
            repositoryName,
            repositoryArn: repository.repositoryArn as RepositoryArn,
            repositoryUri: repository.repositoryUri as RepositoryUri,
            registryId: repository.registryId!,
            imageTagMutability:
              repository.imageTagMutability ??
              output?.imageTagMutability ??
              "MUTABLE",
            lifecyclePolicyText: output?.lifecyclePolicyText,
            policy: yield* readPolicy(repositoryName),
            tags: output?.tags ?? {},
          };
          return (yield* hasAlchemyTags(id, listedTags.tags ?? []))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // Prefer the deployed name: regenerating would target a different
          // repository if the generator's output for this id ever drifts.
          const repositoryName =
            output?.repositoryName ?? (yield* toRepositoryName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live cloud state. We never trust prior `output`
          // blindly: the repository may have been deleted out-of-band.
          let described = yield* ecr
            .describeRepositories({
              repositoryNames: [repositoryName],
            })
            .pipe(
              Effect.catchTag("RepositoryNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          let repository = described?.repositories?.[0];

          // Ensure — create the repository if missing. Tolerate
          // `RepositoryAlreadyExistsException` as a race with a peer
          // reconciler: re-describe and continue with the sync path.
          if (!repository?.repositoryArn || !repository.repositoryUri) {
            const created = yield* ecr
              .createRepository({
                repositoryName,
                imageTagMutability: news.imageTagMutability,
                imageScanningConfiguration: news.scanOnPush
                  ? { scanOnPush: true }
                  : undefined,
                tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag("RepositoryAlreadyExistsException", () =>
                  ecr
                    .describeRepositories({
                      repositoryNames: [repositoryName],
                    })
                    .pipe(
                      Effect.map((res) => ({
                        repository: res.repositories?.[0],
                      })),
                    ),
                ),
              );
            repository = created.repository;
            if (!repository?.repositoryArn || !repository.repositoryUri) {
              return yield* Effect.fail(
                new Error(
                  `Failed to create or read repository ${repositoryName}`,
                ),
              );
            }
          }

          const repositoryArn = repository.repositoryArn as RepositoryArn;

          // Sync lifecycle policy — observed ↔ desired.
          if (news.lifecyclePolicyText) {
            yield* ecr.putLifecyclePolicy({
              repositoryName,
              lifecyclePolicyText: news.lifecyclePolicyText,
            });
          }

          // Sync repository policy — normalized observed ↔ desired.
          const desiredPolicy = toPolicyText(news.policy);
          yield* syncPolicy(repositoryName, desiredPolicy);

          // Sync tags — diff observed cloud tags against desired.
          const listedTags = yield* ecr.listTagsForResource({
            resourceArn: repositoryArn,
          });
          const observedTags = Object.fromEntries(
            (listedTags.tags ?? [])
              .filter(
                (t): t is { Key: string; Value: string } =>
                  typeof t.Key === "string" && typeof t.Value === "string",
              )
              .map((t) => [t.Key, t.Value]),
          );
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* ecr.tagResource({
              resourceArn: repositoryArn,
              tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* ecr.untagResource({
              resourceArn: repositoryArn,
              tagKeys: removed,
            });
          }

          yield* session.note(repositoryArn);
          return {
            repositoryName,
            repositoryArn,
            repositoryUri: repository.repositoryUri as RepositoryUri,
            registryId: repository.registryId!,
            imageTagMutability:
              news.imageTagMutability ??
              repository.imageTagMutability ??
              "MUTABLE",
            lifecyclePolicyText: news.lifecyclePolicyText,
            policy: desiredPolicy,
            tags: desiredTags,
          };
        }),
        // Enumerate every repository in the account/region. `describeRepositories`
        // is paginated (items under `repositories`); for each repo we fetch the
        // tags and lifecycle policy so each element matches the full Attributes
        // shape `read` produces and is directly usable by `delete`.
        list: () =>
          Effect.gen(function* () {
            const repositories = yield* ecr.describeRepositories.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.repositories ?? []),
              ),
            );
            return yield* Effect.forEach(
              repositories.filter(
                (
                  r,
                ): r is ecr.Repository & {
                  repositoryName: string;
                  repositoryArn: string;
                  repositoryUri: string;
                } =>
                  r.repositoryName != null &&
                  r.repositoryArn != null &&
                  r.repositoryUri != null,
              ),
              (repository) =>
                Effect.gen(function* () {
                  const listedTags = yield* ecr.listTagsForResource({
                    resourceArn: repository.repositoryArn,
                  });
                  const tags = Object.fromEntries(
                    (listedTags.tags ?? [])
                      .filter(
                        (t): t is { Key: string; Value: string } =>
                          typeof t.Key === "string" &&
                          typeof t.Value === "string",
                      )
                      .map((t) => [t.Key, t.Value]),
                  );
                  const lifecyclePolicyText = yield* ecr
                    .getLifecyclePolicy({
                      repositoryName: repository.repositoryName,
                    })
                    .pipe(
                      Effect.map((res) => res.lifecyclePolicyText),
                      Effect.catchTag("LifecyclePolicyNotFoundException", () =>
                        Effect.succeed(undefined),
                      ),
                    );
                  return {
                    repositoryName: repository.repositoryName,
                    repositoryArn: repository.repositoryArn as RepositoryArn,
                    repositoryUri: repository.repositoryUri as RepositoryUri,
                    registryId: repository.registryId!,
                    imageTagMutability:
                      repository.imageTagMutability ?? "MUTABLE",
                    lifecyclePolicyText,
                    policy: yield* readPolicy(repository.repositoryName),
                    tags,
                  };
                }),
              { concurrency: 10 },
            );
          }),
        delete: Effect.fn(function* ({ output }) {
          yield* ecr
            .deleteRepository({
              repositoryName: output.repositoryName,
              force: true,
            })
            .pipe(
              Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

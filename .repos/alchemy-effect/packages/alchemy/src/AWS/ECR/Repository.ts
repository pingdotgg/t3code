import * as ecr from "@distilled.cloud/aws/ecr";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
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
   * User-defined tags to apply to the repository.
   */
  tags?: Record<string, string>;
}

export interface Repository extends Resource<
  "AWS.ECR.Repository",
  RepositoryProps,
  {
    repositoryName: RepositoryName;
    repositoryArn: RepositoryArn;
    repositoryUri: RepositoryUri;
    registryId: string;
    imageTagMutability: ecr.ImageTagMutability;
    lifecyclePolicyText?: string;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon ECR repository for container images.
 *
 * @section Creating Repositories
 * @example Task Image Repository
 * ```typescript
 * const repo = yield* Repository("TaskRepository", {
 *   scanOnPush: true,
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
            tags: output?.tags ?? {},
          };
          return (yield* hasAlchemyTags(id, listedTags.tags ?? []))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const repositoryName = yield* toRepositoryName(id, news);
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
            tags: desiredTags,
          };
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

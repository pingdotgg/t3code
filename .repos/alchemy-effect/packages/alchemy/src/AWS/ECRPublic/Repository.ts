import * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { Region } from "../Region.ts";

// Amazon ECR Public is a single global registry hosted only in us-east-1. Every
// control-plane call must target that region regardless of the ambient stack
// region, so we pin it on every distilled operation.
const US_EAST_1 = "us-east-1";
const pin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Region, Effect.succeed(US_EAST_1)));

export type RepositoryName = string;
export type RepositoryArn =
  `arn:aws:ecr-public::${AccountID}:repository/${RepositoryName}`;

/**
 * Catalog display metadata shown on the public.ecr.aws gallery page for a
 * repository. All fields are optional and free-form.
 */
export interface PublicRepositoryCatalogData {
  /** Short description of the contents of the repository. */
  description?: string;
  /** CPU architectures the images support (e.g. `["x86-64", "ARM 64"]`). */
  architectures?: string[];
  /** Operating systems the images support (e.g. `["Linux"]`). */
  operatingSystems?: string[];
  /** Detailed "about" markdown shown on the gallery page. */
  aboutText?: string;
  /** Usage instructions markdown shown on the gallery page. */
  usageText?: string;
}

export interface PublicRepositoryProps {
  /**
   * Name of the public repository. If omitted, a unique name is generated.
   * Must be lowercase.
   */
  repositoryName?: string;
  /**
   * Catalog display metadata for the public gallery page.
   */
  catalogData?: PublicRepositoryCatalogData;
  /**
   * Repository permission policy JSON granting push/pull access to other
   * principals. Omit for a private-push, public-pull repository.
   */
  policyText?: string;
  /**
   * User-defined tags to apply to the repository.
   */
  tags?: Record<string, string>;
}

export interface PublicRepository extends Resource<
  "AWS.ECRPublic.Repository",
  PublicRepositoryProps,
  {
    /** The name of the public repository. */
    repositoryName: RepositoryName;
    /** The ARN of the public repository. */
    repositoryArn: RepositoryArn;
    /** The public pull URI, e.g. `public.ecr.aws/<alias>/<name>`. */
    repositoryUri: string;
    /** The AWS account ID of the registry. */
    registryId: string;
    /** The JSON repository permissions policy, if any. */
    policyText?: string;
    /** The tags attached to the repository. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon ECR Public repository on the public.ecr.aws registry. Images pushed
 * here are pullable by anyone. ECR Public is a global service hosted only in
 * `us-east-1`; this resource pins every control-plane call there regardless of
 * the stack region.
 *
 * @resource
 * @section Creating Public Repositories
 * @example Basic Public Repository
 * ```typescript
 * const repo = yield* PublicRepository("MyPublicRepo", {});
 * ```
 *
 * @example With Catalog Metadata
 * ```typescript
 * const repo = yield* PublicRepository("MyPublicRepo", {
 *   catalogData: {
 *     description: "My awesome container image",
 *     architectures: ["x86-64", "ARM 64"],
 *     operatingSystems: ["Linux"],
 *     aboutText: "# About\nThis image does X.",
 *     usageText: "docker pull public.ecr.aws/...",
 *   },
 * });
 * ```
 *
 * @section Access Policies
 * @example Grant Cross-Account Push
 * ```typescript
 * const repo = yield* PublicRepository("MyPublicRepo", {
 *   policyText: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Sid: "AllowPush",
 *         Effect: "Allow",
 *         Principal: { AWS: "arn:aws:iam::123456789012:root" },
 *         Action: ["ecr-public:BatchCheckLayerAvailability", "ecr-public:PutImage"],
 *       },
 *     ],
 *   }),
 * });
 * ```
 */
export const PublicRepository = Resource<PublicRepository>(
  "AWS.ECRPublic.Repository",
);

const toCatalogInput = (
  catalogData: PublicRepositoryCatalogData | undefined,
): ecrpublic.RepositoryCatalogDataInput | undefined =>
  catalogData
    ? {
        description: catalogData.description,
        architectures: catalogData.architectures,
        operatingSystems: catalogData.operatingSystems,
        aboutText: catalogData.aboutText,
        usageText: catalogData.usageText,
      }
    : undefined;

const toTagRecord = (
  tags: ecrpublic.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (t): t is { Key: string; Value: string } =>
          typeof t.Key === "string" && typeof t.Value === "string",
      )
      .map((t) => [t.Key, t.Value]),
  );

export const PublicRepositoryProvider = () =>
  Provider.effect(
    PublicRepository,
    Effect.gen(function* () {
      const toRepositoryName = (
        id: string,
        props: { repositoryName?: string } = {},
      ) =>
        props.repositoryName
          ? Effect.succeed(props.repositoryName)
          : createPhysicalName({ id, maxLength: 205, lowercase: true });

      const observe = (repositoryName: string) =>
        pin(
          ecrpublic.describeRepositories({
            repositoryNames: [repositoryName],
          }),
        ).pipe(
          Effect.map((r) => r.repositories?.[0]),
          Effect.catchTag("RepositoryNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      const readPolicy = (repositoryName: string) =>
        pin(ecrpublic.getRepositoryPolicy({ repositoryName })).pipe(
          Effect.map((r) => r.policyText),
          Effect.catchTag("RepositoryPolicyNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      const syncPolicy = Effect.fn(function* (
        repositoryName: string,
        desired: string | undefined,
      ) {
        const observed = yield* readPolicy(repositoryName);
        if (desired) {
          if (observed !== desired) {
            yield* pin(
              ecrpublic.setRepositoryPolicy({
                repositoryName,
                policyText: desired,
              }),
            );
          }
        } else if (observed !== undefined) {
          yield* pin(ecrpublic.deleteRepositoryPolicy({ repositoryName })).pipe(
            Effect.catchTag(
              "RepositoryPolicyNotFoundException",
              () => Effect.void,
            ),
          );
        }
      });

      const syncTags = Effect.fn(function* (
        repositoryArn: string,
        desiredTags: Record<string, string>,
      ) {
        const listed = yield* pin(
          ecrpublic.listTagsForResource({ resourceArn: repositoryArn }),
        );
        const observedTags = toTagRecord(listed.tags);
        const { removed, upsert } = diffTags(observedTags, desiredTags);
        if (upsert.length > 0) {
          yield* pin(
            ecrpublic.tagResource({ resourceArn: repositoryArn, tags: upsert }),
          );
        }
        if (removed.length > 0) {
          yield* pin(
            ecrpublic.untagResource({
              resourceArn: repositoryArn,
              tagKeys: removed,
            }),
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
          const repository = yield* observe(repositoryName);
          if (!repository?.repositoryArn || !repository.repositoryUri) {
            return undefined;
          }
          const listed = yield* pin(
            ecrpublic.listTagsForResource({
              resourceArn: repository.repositoryArn,
            }),
          );
          const attrs = {
            repositoryName,
            repositoryArn: repository.repositoryArn as RepositoryArn,
            repositoryUri: repository.repositoryUri,
            registryId: repository.registryId!,
            policyText: yield* readPolicy(repositoryName),
            tags: toTagRecord(listed.tags),
          };
          return (yield* hasAlchemyTags(id, toTagRecord(listed.tags)))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const repositoryName = yield* toRepositoryName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — cloud state is authoritative.
          let repository = yield* observe(repositoryName);

          // Ensure — create if missing. Tolerate the AlreadyExists race.
          if (!repository?.repositoryArn || !repository.repositoryUri) {
            const created = yield* pin(
              ecrpublic.createRepository({
                repositoryName,
                catalogData: toCatalogInput(news.catalogData),
                tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              }),
            ).pipe(
              Effect.map((r) => r.repository),
              Effect.catchTag("RepositoryAlreadyExistsException", () =>
                observe(repositoryName),
              ),
            );
            repository = created;
            if (!repository?.repositoryArn || !repository.repositoryUri) {
              return yield* Effect.fail(
                new Error(
                  `Failed to create or read public repository ${repositoryName}`,
                ),
              );
            }
          } else if (news.catalogData) {
            // Sync catalog data on updates (create already set it).
            yield* pin(
              ecrpublic.putRepositoryCatalogData({
                repositoryName,
                catalogData: toCatalogInput(news.catalogData)!,
              }),
            );
          }

          const repositoryArn = repository.repositoryArn as RepositoryArn;

          yield* syncPolicy(repositoryName, news.policyText);
          yield* syncTags(repositoryArn, desiredTags);

          yield* session.note(repositoryArn);
          return {
            repositoryName,
            repositoryArn,
            repositoryUri: repository.repositoryUri,
            registryId: repository.registryId!,
            policyText: news.policyText,
            tags: desiredTags,
          };
        }),
        // Enumerate every public repository in the account. `describeRepositories`
        // is paginated (items under `repositories`).
        list: () =>
          Effect.gen(function* () {
            const repositories = yield* pin(
              ecrpublic.describeRepositories.pages({}).pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((page) => page.repositories ?? []),
                ),
              ),
            );
            return yield* Effect.forEach(
              repositories.filter(
                (
                  r,
                ): r is ecrpublic.Repository & {
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
                  const listed = yield* pin(
                    ecrpublic.listTagsForResource({
                      resourceArn: repository.repositoryArn,
                    }),
                  );
                  return {
                    repositoryName: repository.repositoryName,
                    repositoryArn: repository.repositoryArn as RepositoryArn,
                    repositoryUri: repository.repositoryUri,
                    registryId: repository.registryId!,
                    policyText: yield* readPolicy(repository.repositoryName),
                    tags: toTagRecord(listed.tags),
                  };
                }),
              { concurrency: 10 },
            );
          }),
        delete: Effect.fn(function* ({ output }) {
          yield* pin(
            ecrpublic.deleteRepository({
              repositoryName: output.repositoryName,
              force: true,
            }),
          ).pipe(
            Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );

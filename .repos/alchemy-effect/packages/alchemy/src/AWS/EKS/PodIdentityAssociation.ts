import * as eks from "@distilled.cloud/aws/eks";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";

export interface PodIdentityAssociationProps {
  /**
   * Target cluster name.
   */
  clusterName: Input<string>;
  /**
   * Kubernetes namespace that owns the service account.
   */
  namespace: string;
  /**
   * Kubernetes service account name.
   */
  serviceAccount: string;
  /**
   * IAM role ARN assumed by pods for this association.
   */
  roleArn: Input<string>;
  /**
   * Disable session tags for the issued credentials.
   */
  disableSessionTags?: boolean;
  /**
   * Optional target role ARN for chained role assumption.
   */
  targetRoleArn?: Input<string>;
  /**
   * Optional inline session policy JSON.
   */
  policy?: string;
  /**
   * User-defined tags to apply to the association.
   */
  tags?: Record<string, string>;
}

export interface PodIdentityAssociation extends Resource<
  "AWS.EKS.PodIdentityAssociation",
  PodIdentityAssociationProps,
  {
    associationArn: string;
    associationId: string;
    clusterName: string;
    namespace: string;
    serviceAccount: string;
    roleArn: string;
    disableSessionTags: boolean;
    targetRoleArn: string | undefined;
    externalId: string | undefined;
    ownerArn: string | undefined;
    policy: string | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon EKS pod identity association that binds a service account to an IAM role.
 *
 * `PodIdentityAssociation` is the canonical workload-identity resource for EKS
 * clusters that use EKS Pod Identity instead of IRSA.
 *
 * @section Managing Pod Identity
 * @example Bind a Service Account to a Role
 * ```typescript
 * const association = yield* PodIdentityAssociation("ApiIdentity", {
 *   clusterName: cluster.clusterName,
 *   namespace: "default",
 *   serviceAccount: "api",
 *   roleArn: podRole.roleArn,
 * });
 * ```
 */
export const PodIdentityAssociation = Resource<PodIdentityAssociation>(
  "AWS.EKS.PodIdentityAssociation",
);

export const PodIdentityAssociationProvider = () =>
  Provider.effect(
    PodIdentityAssociation,
    Effect.gen(function* () {
      const toClientRequestToken = (id: string, action: string) =>
        createPhysicalName({
          id: `${id}-${action}`,
          maxLength: 64,
          delimiter: "-",
        });

      return {
        stables: ["associationArn", "associationId"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds.clusterName !== news.clusterName) {
            return { action: "replace" } as const;
          }

          if (olds.namespace !== news.namespace) {
            return { action: "replace" } as const;
          }

          if (olds.serviceAccount !== news.serviceAccount) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.associationId) {
            return yield* readAssociationById({
              clusterName: output.clusterName,
              associationId: output.associationId,
            });
          }

          return yield* findAssociation({
            id,
            clusterName: olds.clusterName as string,
            namespace: olds.namespace,
            serviceAccount: olds.serviceAccount,
          });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const clusterName = news.clusterName as string;
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — locate the association either by stored
          // associationId or by listing on (cluster, namespace, sa).
          let state = output?.associationId
            ? yield* readAssociationById({
                clusterName,
                associationId: output.associationId,
              })
            : yield* findAssociation({
                id,
                clusterName,
                namespace: news.namespace,
                serviceAccount: news.serviceAccount,
              });

          // Ensure — create if missing. Tolerate `ResourceInUseException`
          // as a race with a peer reconciler.
          if (!state) {
            yield* eks
              .createPodIdentityAssociation({
                clusterName,
                namespace: news.namespace,
                serviceAccount: news.serviceAccount,
                roleArn: news.roleArn as string,
                disableSessionTags: news.disableSessionTags,
                targetRoleArn: news.targetRoleArn as string | undefined,
                policy: news.policy,
                tags: desiredTags,
                clientRequestToken: yield* toClientRequestToken(id, "create"),
              })
              .pipe(
                Effect.catchTag("ResourceInUseException", () => Effect.void),
              );

            state = yield* findAssociation({
              id,
              clusterName,
              namespace: news.namespace,
              serviceAccount: news.serviceAccount,
            });

            if (!state) {
              return yield* Effect.fail(
                new Error(
                  `PodIdentityAssociation '${news.namespace}/${news.serviceAccount}' could not be read after creation`,
                ),
              );
            }
          }

          // Sync mutable fields — observed ↔ desired.
          const desiredRoleArn = news.roleArn as string;
          const desiredTargetRoleArn = news.targetRoleArn as string | undefined;
          const desiredDisableSessionTags = news.disableSessionTags ?? false;
          if (
            state.roleArn !== desiredRoleArn ||
            state.disableSessionTags !== desiredDisableSessionTags ||
            state.targetRoleArn !== desiredTargetRoleArn ||
            state.policy !== news.policy
          ) {
            yield* eks.updatePodIdentityAssociation({
              clusterName,
              associationId: state.associationId,
              roleArn: desiredRoleArn,
              disableSessionTags: news.disableSessionTags,
              targetRoleArn: desiredTargetRoleArn,
              policy: news.policy,
              clientRequestToken: yield* toClientRequestToken(id, "update"),
            });
          }

          // Sync tags — diff observed cloud tags against desired.
          const { removed, upsert } = diffTags(state.tags, desiredTags);
          if (upsert.length > 0) {
            yield* eks.tagResource({
              resourceArn: state.associationArn,
              tags: Object.fromEntries(
                upsert.map((tag) => [tag.Key, tag.Value] as const),
              ),
            });
          }
          if (removed.length > 0) {
            yield* eks.untagResource({
              resourceArn: state.associationArn,
              tagKeys: removed,
            });
          }

          // Re-read final state for fresh attributes.
          const final = yield* readAssociationById({
            clusterName,
            associationId: state.associationId,
          });
          if (!final) {
            return yield* Effect.fail(
              new Error(
                `PodIdentityAssociation '${state.associationId}' could not be read after reconcile`,
              ),
            );
          }

          yield* session.note(final.associationArn);
          return final;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* eks
            .deletePodIdentityAssociation({
              clusterName: output.clusterName,
              associationId: output.associationId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

const normalizeTags = (tags: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const mapAssociation = (association: eks.PodIdentityAssociation) => ({
  associationArn: association.associationArn!,
  associationId: association.associationId!,
  clusterName: association.clusterName!,
  namespace: association.namespace!,
  serviceAccount: association.serviceAccount!,
  roleArn: association.roleArn!,
  disableSessionTags: association.disableSessionTags ?? false,
  targetRoleArn: association.targetRoleArn,
  externalId: association.externalId,
  ownerArn: association.ownerArn,
  policy: association.policy,
  tags: normalizeTags(association.tags),
});

const readAssociationById = Effect.fn(function* ({
  clusterName,
  associationId,
}: {
  clusterName: string;
  associationId: string;
}) {
  const response = yield* eks
    .describePodIdentityAssociation({
      clusterName,
      associationId,
    })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

  const association = response?.association;
  if (
    !association?.associationArn ||
    !association.associationId ||
    !association.clusterName ||
    !association.namespace ||
    !association.serviceAccount ||
    !association.roleArn
  ) {
    return undefined;
  }

  return mapAssociation(association);
});

const findAssociation = Effect.fn(function* ({
  id,
  clusterName,
  namespace,
  serviceAccount,
}: {
  id: string;
  clusterName: string;
  namespace: string;
  serviceAccount: string;
}) {
  let nextToken: string | undefined;
  type Association = {
    associationArn: string;
    associationId: string;
    clusterName: string;
    namespace: string;
    serviceAccount: string;
    roleArn: string;
    disableSessionTags: boolean;
    targetRoleArn: string | undefined;
    externalId: string | undefined;
    ownerArn: string | undefined;
    policy: string | undefined;
    tags: Record<string, string>;
  };
  let firstMatch: Association | undefined;

  while (true) {
    const response = yield* eks.listPodIdentityAssociations({
      clusterName,
      namespace,
      serviceAccount,
      nextToken,
    });

    for (const summary of response.associations ?? []) {
      if (!summary.associationId) {
        continue;
      }

      const association = yield* readAssociationById({
        clusterName,
        associationId: summary.associationId,
      });

      if (!association) continue;

      if (yield* hasAlchemyTags(id, association.tags)) {
        return association as Association;
      }
      firstMatch ??= association as Association;
    }

    if (!response.nextToken) {
      return firstMatch ? Unowned(firstMatch) : undefined;
    }

    nextToken = response.nextToken;
  }
});

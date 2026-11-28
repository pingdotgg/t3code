import * as eks from "@distilled.cloud/aws/eks";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, diffTags, hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";

export class AccessEntryUnexpectedResponse extends Data.TaggedError(
  "AccessEntryUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface AccessPolicyAssociation {
  /**
   * ARN of the AWS-managed EKS access policy.
   */
  policyArn: string;
  /**
   * Scope the policy applies to.
   */
  accessScope: eks.AccessScope;
}

export interface AccessEntryProps {
  /**
   * Target cluster name.
   */
  clusterName: Input<string>;
  /**
   * IAM principal ARN to grant access to.
   */
  principalArn: Input<string>;
  /**
   * Optional Kubernetes groups for the principal.
   */
  kubernetesGroups?: string[];
  /**
   * Optional username to map inside Kubernetes. If omitted, EKS generates one,
   * and removing a username you set resets it to the generated default.
   */
  username?: string;
  /**
   * Entry type, such as `STANDARD`.
   */
  type?: string;
  /**
   * Exact set of EKS access policies associated with this entry.
   */
  accessPolicies?: AccessPolicyAssociation[];
  /**
   * User-defined tags to apply to the access entry.
   */
  tags?: Record<string, string>;
}

export interface AccessEntry extends Resource<
  "AWS.EKS.AccessEntry",
  AccessEntryProps,
  {
    /** The ARN of the access entry. */
    accessEntryArn: string;
    /** The name of the EKS cluster the entry grants access to. */
    clusterName: string;
    /** The IAM principal ARN the entry maps into the cluster. */
    principalArn: string;
    /** The Kubernetes groups the principal is mapped to. */
    kubernetesGroups: string[];
    /** The Kubernetes username the principal is mapped to. */
    username: string | undefined;
    /** The access entry type (e.g. `STANDARD`, `EC2_LINUX`, `FARGATE_LINUX`). */
    type: string | undefined;
    /** The EKS access policies associated with the entry. */
    accessPolicies: AccessPolicyAssociation[];
    /** The tags applied to the access entry. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon EKS access entry that grants an IAM principal access to a cluster.
 *
 * `AccessEntry` owns both the entry itself and the exact set of associated EKS
 * access policies, making cluster access explicit and updatable after initial
 * cluster bootstrap.
 * ### Managing Cluster Access
 * **Example:** Grant Read Access to a Role
 * ```typescript
 * const viewer = yield* AccessEntry("ViewerAccess", {
 *   clusterName: cluster.clusterName,
 *   principalArn: viewerRole.roleArn,
 *   accessPolicies: [
 *     {
 *       policyArn:
 *         "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy",
 *       accessScope: {
 *         type: "cluster",
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const AccessEntry = Resource<AccessEntry>("AWS.EKS.AccessEntry");

export const AccessEntryProvider = () =>
  Provider.succeed(AccessEntry, {
    stables: ["accessEntryArn"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.clusterName !== news.clusterName) {
        return { action: "replace" } as const;
      }

      if (olds.principalArn !== news.principalArn) {
        return { action: "replace" } as const;
      }

      if ((olds.type ?? "STANDARD") !== (news.type ?? "STANDARD")) {
        return { action: "replace" } as const;
      }
    }),
    // Enumerate every access entry across every cluster in the account/region.
    // `listAccessEntries` requires a cluster name, so enumerate clusters first
    // (`listClusters`), then list access entry principal ARNs per cluster, then
    // hydrate each one through `readAccessEntry` (describe + associated policies)
    // to produce the full `read`-shaped Attributes. All pagination is exhausted.
    list: Effect.fn(function* () {
      const clusterNames = yield* eks.listClusters.items({}).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );

      const perCluster = yield* Effect.forEach(
        clusterNames,
        (clusterName) =>
          Effect.gen(function* () {
            const cluster = yield* eks.describeCluster({ name: clusterName }).pipe(
              Effect.map((response) => response.cluster),
              Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
            );
            // CONFIG_MAP clusters have no access entries, and EKS rejects
            // ListAccessEntries on them.
            if (
              cluster === undefined ||
              (cluster.accessConfig?.authenticationMode ?? "CONFIG_MAP") === "CONFIG_MAP"
            ) {
              return [];
            }
            const principalArns = yield* eks.listAccessEntries.items({ clusterName }).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.catchTag("ResourceNotFoundException", () => Effect.succeed([] as string[])),
            );
            return yield* Effect.forEach(
              principalArns,
              (principalArn) => readAccessEntry({ clusterName, principalArn }),
              { concurrency: 5 },
            );
          }),
        { concurrency: 5 },
      );

      return perCluster.flat().filter((entry): entry is NonNullable<typeof entry> => entry != null);
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const state = yield* readAccessEntry({
        clusterName: (output?.clusterName ?? olds.clusterName) as string,
        principalArn: (output?.principalArn ?? olds.principalArn) as string,
      });
      if (!state) return undefined;
      return (yield* hasAlchemyTags(id, state.tags)) ? state : Unowned(state);
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, session }) {
      const clusterName = news.clusterName as string;
      const principalArn = news.principalArn as string;
      const desiredTags = {
        ...(yield* createInternalTags(id)),
        ...news.tags,
      };

      // Observe — fetch live cloud state by (clusterName, principalArn).
      let state = yield* readAccessEntry({
        clusterName,
        principalArn,
      });

      // Ensure — create the entry if missing. Tolerate
      // `ResourceInUseException` as a race with a peer reconciler.
      let created = false;
      if (!state) {
        created = yield* eks
          .createAccessEntry({
            clusterName,
            principalArn,
            kubernetesGroups: news.kubernetesGroups,
            username: news.username,
            type: news.type,
            tags: desiredTags,
          })
          .pipe(
            Effect.as(true),
            Effect.catchTag("ResourceInUseException", () => Effect.succeed(false)),
          );

        state = yield* readAccessEntry({
          clusterName,
          principalArn,
        });

        if (!state) {
          return yield* new AccessEntryUnexpectedResponse({
            message: `AccessEntry '${principalArn}' could not be read after creation`,
          });
        }
      }

      // Sync kubernetesGroups + username — observed ↔ desired. Groups are a
      // set. An update that omits the username resets it to the EKS-generated
      // default, which can't be told apart from a custom one by observation.
      // So an omitted username is only re-sent when one may have been set:
      // a username in `olds`, or an adopted entry this reconcile did not create.
      const desiredGroups = news.kubernetesGroups ?? [];
      const groupsChanged =
        JSON.stringify([...state.kubernetesGroups].sort()) !==
        JSON.stringify([...desiredGroups].sort());
      const usernameChanged =
        news.username !== undefined
          ? state.username !== news.username
          : !created && (olds === undefined || olds.username !== undefined);
      if (groupsChanged || usernameChanged) {
        yield* eks.updateAccessEntry({
          clusterName,
          principalArn,
          kubernetesGroups: desiredGroups,
          username: news.username,
        });
      }

      // Sync tags — diff observed cloud tags against desired.
      const { removed, upsert } = diffTags(state.tags, desiredTags);
      if (upsert.length > 0) {
        yield* eks.tagResource({
          resourceArn: state.accessEntryArn,
          tags: Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value] as const)),
        });
      }
      if (removed.length > 0) {
        yield* eks.untagResource({
          resourceArn: state.accessEntryArn,
          tagKeys: removed,
        });
      }

      // Sync access policy associations — diff observed against desired.
      const observedPolicies = state.accessPolicies;
      const desiredPolicies = normalizeAccessPolicies(news.accessPolicies);
      const observedPolicyMap = new Map(
        observedPolicies.map((policy) => [policyKey(policy), policy]),
      );
      const desiredPolicyMap = new Map(
        desiredPolicies.map((policy) => [policyKey(policy), policy]),
      );

      for (const [key, policy] of desiredPolicyMap) {
        if (!observedPolicyMap.has(key)) {
          yield* eks.associateAccessPolicy({
            clusterName,
            principalArn,
            policyArn: policy.policyArn,
            accessScope: policy.accessScope,
          });
        }
      }

      // EKS keeps one association per policy ARN and `associateAccessPolicy`
      // replaces its scope in place, while `disassociateAccessPolicy` takes no
      // scope. Disassociating a still-desired ARN would undo the associate
      // above, so only disassociate ARNs that are no longer desired.
      const desiredPolicyArns = new Set(desiredPolicies.map((policy) => policy.policyArn));
      for (const [key, policy] of observedPolicyMap) {
        if (!desiredPolicyMap.has(key) && !desiredPolicyArns.has(policy.policyArn)) {
          yield* eks.disassociateAccessPolicy({
            clusterName,
            principalArn,
            policyArn: policy.policyArn,
          });
        }
      }

      yield* session.note(state.accessEntryArn);

      // Re-read final state so returned attributes reflect post-sync.
      return yield* readAccessEntry({
        clusterName,
        principalArn,
      }).pipe(
        Effect.flatMap((finalState) =>
          finalState
            ? Effect.succeed(finalState)
            : Effect.fail(
                new AccessEntryUnexpectedResponse({
                  message: `AccessEntry '${principalArn}' could not be read after reconcile`,
                }),
              ),
        ),
      );
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* eks
        .deleteAccessEntry({
          clusterName: output.clusterName,
          principalArn: output.principalArn,
        })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
    }),
  });

const normalizeTags = (tags: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

// EKS reports a cluster scope as `{ type: "cluster", namespaces: [] }`, so
// compare scopes in one canonical shape rather than as raw JSON.
const scopeKey = (scope: eks.AccessScope) =>
  JSON.stringify({ type: scope.type, namespaces: [...(scope.namespaces ?? [])].sort() });

const comparePolicyAssociation = (a: AccessPolicyAssociation, b: AccessPolicyAssociation) =>
  a.policyArn.localeCompare(b.policyArn) ||
  scopeKey(a.accessScope).localeCompare(scopeKey(b.accessScope));

const normalizeAccessPolicies = (
  policies: ReadonlyArray<AccessPolicyAssociation | eks.AssociatedAccessPolicy> | undefined,
): AccessPolicyAssociation[] =>
  (policies ?? [])
    .flatMap((policy) =>
      policy.policyArn && policy.accessScope
        ? [
            {
              policyArn: policy.policyArn,
              accessScope: policy.accessScope,
            },
          ]
        : [],
    )
    .sort(comparePolicyAssociation);

const policyKey = (policy: AccessPolicyAssociation) =>
  `${policy.policyArn}::${scopeKey(policy.accessScope)}`;

const listAccessPolicies = Effect.fn(function* ({
  clusterName,
  principalArn,
}: {
  clusterName: string;
  principalArn: string;
}) {
  const policies: AccessPolicyAssociation[] = [];
  let nextToken: string | undefined;

  while (true) {
    const response = yield* eks.listAssociatedAccessPolicies({
      clusterName,
      principalArn,
      nextToken,
    });

    policies.push(...normalizeAccessPolicies(response.associatedAccessPolicies));

    if (!response.nextToken) {
      break;
    }

    nextToken = response.nextToken;
  }

  return policies.sort(comparePolicyAssociation);
});

const readAccessEntry = Effect.fn(function* ({
  clusterName,
  principalArn,
}: {
  clusterName: string;
  principalArn: string;
}) {
  const response = yield* eks
    .describeAccessEntry({
      clusterName,
      principalArn,
    })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));

  const accessEntry = response?.accessEntry;
  if (!accessEntry?.accessEntryArn || !accessEntry.clusterName || !accessEntry.principalArn) {
    return undefined;
  }

  return {
    accessEntryArn: accessEntry.accessEntryArn,
    clusterName: accessEntry.clusterName,
    principalArn: accessEntry.principalArn,
    kubernetesGroups: accessEntry.kubernetesGroups ?? [],
    username: accessEntry.username,
    type: accessEntry.type,
    accessPolicies: yield* listAccessPolicies({
      clusterName: accessEntry.clusterName,
      principalArn: accessEntry.principalArn,
    }),
    tags: normalizeTags(accessEntry.tags),
  };
});

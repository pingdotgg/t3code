/**
 * Internal pod-identity + host-binding machinery behind the `aws-eks`
 * cluster adapter's workload-identity implementation (see
 * `../KubernetesAdapter.ts`). Each helper is an independently idempotent
 * mini-reconciler: observe, ensure, converge.
 */
import * as eks from "@distilled.cloud/aws/eks";
import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../../PhysicalName.ts";
import type { ResourceBinding } from "../../../Resource.ts";
import { createInternalTags, hasTags } from "../../../Tags.ts";
import type { PolicyStatement } from "../../IAM/Policy.ts";

export const toClientRequestToken = (id: string, action: string) =>
  createPhysicalName({
    id: `${id}-${action}`,
    maxLength: 64,
    delimiter: "-",
  });

/**
 * Ensure the pod-identity IAM role exists (trusts `pods.eks.amazonaws.com`).
 * Idempotent: creates on miss, adopts a role we already own on race.
 */
export const ensurePodRole = Effect.fn(function* ({
  id,
  roleName,
  managedPolicyArns,
}: {
  id: string;
  roleName: string;
  managedPolicyArns?: string[];
}) {
  const tags = yield* createInternalTags(id);
  const role = yield* iam
    .createRole({
      RoleName: roleName,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "pods.eks.amazonaws.com" },
            Action: ["sts:AssumeRole", "sts:TagSession"],
          },
        ],
      }),
      Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
    })
    .pipe(
      Effect.catchTag("EntityAlreadyExistsException", () =>
        iam.getRole({ RoleName: roleName }).pipe(
          Effect.filterOrFail(
            (existing) => hasTags(tags, existing.Role?.Tags),
            () =>
              new Error(
                `Role '${roleName}' already exists and is not managed by alchemy`,
              ),
          ),
        ),
      ),
    );
  for (const policyArn of managedPolicyArns ?? []) {
    yield* iam
      .attachRolePolicy({ RoleName: roleName, PolicyArn: policyArn })
      .pipe(Effect.catchTag("LimitExceededException", () => Effect.void));
  }
  return role.Role!.Arn!;
});

export interface HostBindingContract {
  env?: Record<string, any>;
  policyStatements?: PolicyStatement[];
}

/**
 * Land the IAM policy statements carried by a host's active bindings as
 * the pod role's inline policy (or delete it when no statements remain).
 * Binding env collection is generic and lives in the Kubernetes workload
 * providers.
 */
export const attachPolicyStatements = Effect.fn(function* ({
  roleName,
  policyName,
  bindings,
}: {
  roleName: string;
  policyName: string;
  bindings: ResourceBinding<HostBindingContract>[];
}) {
  const activeBindings = bindings.filter(
    (
      binding: ResourceBinding<HostBindingContract> & {
        action?: string;
      },
    ) => binding.action !== "delete",
  );

  const policyStatements = activeBindings.flatMap(
    (binding) =>
      binding?.data?.policyStatements?.map((statement) => ({
        ...statement,
        Sid: statement.Sid?.replace(/[^A-Za-z0-9]+/gi, ""),
      })) ?? [],
  );

  if (policyStatements.length > 0) {
    yield* iam.putRolePolicy({
      RoleName: roleName,
      PolicyName: policyName,
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: policyStatements,
      }),
    });
  } else {
    yield* iam
      .deleteRolePolicy({ RoleName: roleName, PolicyName: policyName })
      .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
  }
});

/** Observe an existing pod identity association for (cluster, ns, sa). */
export const findAssociation = Effect.fn(function* ({
  clusterName,
  namespace,
  serviceAccount,
}: {
  clusterName: string;
  namespace: string;
  serviceAccount: string;
}) {
  const listed = yield* eks.listPodIdentityAssociations({
    clusterName,
    namespace,
    serviceAccount,
  });
  const summary = listed.associations?.[0];
  if (!summary?.associationId) return undefined;
  const described = yield* eks
    .describePodIdentityAssociation({
      clusterName,
      associationId: summary.associationId,
    })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  const association = described?.association;
  if (!association?.associationArn || !association.associationId) {
    return undefined;
  }
  return {
    associationArn: association.associationArn,
    associationId: association.associationId,
    roleArn: association.roleArn,
  };
});

/** Ensure the pod identity association exists and points at roleArn. */
export const ensureAssociation = Effect.fn(function* ({
  id,
  clusterName,
  namespace,
  serviceAccount,
  roleArn,
}: {
  id: string;
  clusterName: string;
  namespace: string;
  serviceAccount: string;
  roleArn: string;
}) {
  let state = yield* findAssociation({
    clusterName,
    namespace,
    serviceAccount,
  });
  if (!state) {
    yield* eks
      .createPodIdentityAssociation({
        clusterName,
        namespace,
        serviceAccount,
        roleArn,
        tags: yield* createInternalTags(id),
        clientRequestToken: yield* toClientRequestToken(id, "assoc"),
      })
      .pipe(Effect.catchTag("ResourceInUseException", () => Effect.void));
    state = yield* findAssociation({
      clusterName,
      namespace,
      serviceAccount,
    });
    if (!state) {
      return yield* Effect.fail(
        new Error(
          `PodIdentityAssociation '${namespace}/${serviceAccount}' could not be read after creation`,
        ),
      );
    }
  } else if (state.roleArn !== roleArn) {
    yield* eks.updatePodIdentityAssociation({
      clusterName,
      associationId: state.associationId,
      roleArn,
      clientRequestToken: yield* toClientRequestToken(id, "assoc-update"),
    });
  }
  return {
    associationArn: state.associationArn,
    associationId: state.associationId,
  };
});

/** Delete the pod identity association; missing is success. */
export const deleteAssociation = Effect.fn(function* ({
  clusterName,
  associationId,
}: {
  clusterName: string;
  associationId: string;
}) {
  yield* eks
    .deletePodIdentityAssociation({
      clusterName,
      associationId,
    })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
});

/**
 * Fully delete a pod IAM role: inline policies, managed-policy attachments,
 * then the role itself. Idempotent throughout.
 */
export const deletePodRole = Effect.fn(function* (roleName: string) {
  yield* iam.listRolePolicies.items({ RoleName: roleName }).pipe(
    Stream.mapEffect((policyName) =>
      iam
        .deleteRolePolicy({
          RoleName: roleName,
          PolicyName: policyName,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void)),
    ),
    Stream.runDrain,
    Effect.catchTag("NoSuchEntityException", () => Effect.void),
  );

  yield* iam.listAttachedRolePolicies.items({ RoleName: roleName }).pipe(
    Stream.mapEffect((policy) =>
      iam
        .detachRolePolicy({
          RoleName: roleName,
          PolicyArn: policy.PolicyArn!,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void)),
    ),
    Stream.runDrain,
    Effect.catchTag("NoSuchEntityException", () => Effect.void),
  );

  yield* iam
    .deleteRole({ RoleName: roleName })
    .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
});

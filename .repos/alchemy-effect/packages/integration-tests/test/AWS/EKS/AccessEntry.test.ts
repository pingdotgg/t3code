import * as AWS from "@alchemy.run/aws";
import { Network } from "@alchemy.run/aws/EC2/Network";
import { AccessEntry, Cluster } from "@alchemy.run/aws/EKS";
import { Role } from "@alchemy.run/aws/IAM";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as eks from "@distilled.cloud/aws/eks";
import * as iam from "@distilled.cloud/aws/iam";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated live probe: `list()` enumerates every EKS access entry across every
// cluster in the account/region. It walks `listClusters` (paginated), then
// `listAccessEntries` per cluster (paginated), and hydrates each via
// `describeAccessEntry` + `listAssociatedAccessPolicies` into the same
// Attributes shape `read` returns. We don't deploy here because a fresh EKS
// cluster takes 10+ minutes to provision (see the gated test below) — but this
// still verifies the cluster-fan-out + pagination + mapping against the live
// API and asserts every returned row is well-formed (the array is empty when
// the account has no clusters).
test.provider(
  "list returns the account/region access entries",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(AccessEntry);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const entry of all) {
        expect(typeof entry.accessEntryArn).toBe("string");
        expect(typeof entry.clusterName).toBe("string");
        expect(typeof entry.principalArn).toBe("string");
        expect(Array.isArray(entry.kubernetesGroups)).toBe(true);
        expect(Array.isArray(entry.accessPolicies)).toBe(true);
        expect(entry.tags).toBeDefined();
      }
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"] },
);

// Full deploy-then-list assertion. SKIPPED by default because an EKS cluster
// takes 10+ minutes to create (and requires a VPC + subnets + cluster IAM
// role), which exceeds the CI budget. Set AWS_TEST_EKS_CLUSTER to the name of a
// pre-provisioned cluster to run it on an entitled account unchanged. A
// throwaway IAM role is created out-of-band to serve as the access entry's
// principal.
const clusterName = process.env.AWS_TEST_EKS_CLUSTER;

const principalRoleName = "alchemy-test-eks-accessentry-list-principal";

test.provider.skipIf(!clusterName)(
  "list enumerates the deployed access entry",
  (stack) =>
    Effect.gen(function* () {
      // Idempotent delete: safe when the role never existed (pre-clean) or was
      // already removed (post-clean after a partial prior run).
      const deletePrincipalRole = iam
        .deleteRole({ RoleName: principalRoleName })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));

      yield* stack.destroy();

      // acquireRelease guarantees the out-of-band role is deleted on success,
      // failure, AND interruption; the deterministic name + pre-clean above
      // means a re-run reclaims any orphan from a previously-killed run.
      yield* Effect.gen(function* () {
        const role = yield* Effect.acquireRelease(
          // Pre-clean a leftover from a killed run, then create.
          deletePrincipalRole.pipe(
            Effect.andThen(
              iam.createRole({
                RoleName: principalRoleName,
                AssumeRolePolicyDocument: JSON.stringify({
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Principal: { Service: "ec2.amazonaws.com" },
                      Action: ["sts:AssumeRole"],
                    },
                  ],
                }),
              }),
            ),
          ),
          () => deletePrincipalRole.pipe(Effect.catch(() => Effect.void)),
        );

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* AccessEntry("ListAccessEntry", {
              clusterName: clusterName!,
              principalArn: role.Role.Arn,
            });
          }),
        );

        const provider = yield* Provider.findProvider(AccessEntry);
        const all = yield* provider.list();

        expect(all.some((entry) => entry.accessEntryArn === deployed.accessEntryArn)).toBe(true);

        yield* stack.destroy();
      }).pipe(Effect.scoped);
    }),
  {
    tags: ["provider:aws", "provider:aws:eks", "provider:aws:iam", "live"],
    timeout: 240_000,
  },
);

const viewPolicyArn = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy";
const editPolicyArn = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy";
const adminPolicyArn = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy";

const principalTrustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "ec2.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

// Regression for #2192: EKS reports a cluster scope as
// `{ type: "cluster", namespaces: [] }`, which never matched the desired
// `{ type: "cluster" }`, so every reconcile re-associated and then
// disassociated the policy — leaving the principal with no access. A scope
// change took the same associate-then-disassociate path. Every step bumps the
// `revision` tag so the entry is reconciled even when its policies are
// unchanged. Provisions its own Auto Mode cluster (~10 min create, ~5 min
// delete), so it skips under `--fast`.
test.provider.skipIf(!!process.env.FAST)(
  "reconcile converges policies, groups, and username without spurious updates",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployEntry = (
        revision: string,
        accessPolicies?: { policyArn: string; accessScope: eks.AccessScope }[],
        identity: { kubernetesGroups?: string[]; username?: string } = {},
      ) =>
        stack.deploy(
          Effect.gen(function* () {
            const network = yield* Network("AccessEntryNetwork", {
              cidrBlock: "10.85.0.0/16",
              availabilityZones: 2,
            });
            const cluster = yield* Cluster("AccessEntryCluster", {
              compute: "auto",
              resourcesVpcConfig: {
                subnetIds: network.publicSubnetIds,
                endpointPublicAccess: true,
              },
            });
            const principal = yield* Role("AccessEntryPrincipal", {
              assumeRolePolicyDocument: principalTrustPolicy,
            });
            return yield* AccessEntry("PolicyAccessEntry", {
              clusterName: cluster.clusterName,
              principalArn: principal.roleArn,
              accessPolicies,
              kubernetesGroups: identity.kubernetesGroups,
              username: identity.username,
              tags: { revision },
            });
          }),
        );

      const associated = (entry: AccessEntry["Attributes"]) =>
        eks
          .listAssociatedAccessPolicies({
            clusterName: entry.clusterName,
            principalArn: entry.principalArn,
          })
          .pipe(
            Effect.map((response) =>
              Object.fromEntries(
                (response.associatedAccessPolicies ?? []).map((policy) => [
                  policy.policyArn!,
                  {
                    type: policy.accessScope?.type,
                    namespaces: [...(policy.accessScope?.namespaces ?? [])].sort(),
                  },
                ]),
              ),
            ),
          );

      const described = (entry: AccessEntry["Attributes"]) =>
        eks
          .describeAccessEntry({
            clusterName: entry.clusterName,
            principalArn: entry.principalArn,
          })
          .pipe(Effect.map((response) => response.accessEntry!));

      const clusterScope = { type: "cluster", namespaces: [] };

      // Create with a cluster-scoped and a namespace-scoped policy.
      const created = yield* deployEntry("1", [
        { policyArn: viewPolicyArn, accessScope: { type: "cluster" } },
        { policyArn: editPolicyArn, accessScope: { type: "namespace", namespaces: ["a"] } },
      ]);
      expect(yield* associated(created)).toEqual({
        [viewPolicyArn]: clusterScope,
        [editPolicyArn]: { type: "namespace", namespaces: ["a"] },
      });

      // Unchanged policies survive a reconcile.
      const retagged = yield* deployEntry("2", [
        { policyArn: viewPolicyArn, accessScope: { type: "cluster" } },
        { policyArn: editPolicyArn, accessScope: { type: "namespace", namespaces: ["a"] } },
      ]);
      expect(yield* associated(retagged)).toEqual({
        [viewPolicyArn]: clusterScope,
        [editPolicyArn]: { type: "namespace", namespaces: ["a"] },
      });

      // A namespace change updates the association in place, and a policy
      // added to an existing entry is associated.
      const rescoped = yield* deployEntry("3", [
        { policyArn: viewPolicyArn, accessScope: { type: "cluster" } },
        { policyArn: editPolicyArn, accessScope: { type: "namespace", namespaces: ["b", "a"] } },
        { policyArn: adminPolicyArn, accessScope: { type: "namespace", namespaces: ["a"] } },
      ]);
      expect(yield* associated(rescoped)).toEqual({
        [viewPolicyArn]: clusterScope,
        [editPolicyArn]: { type: "namespace", namespaces: ["a", "b"] },
        [adminPolicyArn]: { type: "namespace", namespaces: ["a"] },
      });

      // A scope type change updates the association in place, and the same
      // namespaces in a different order are unchanged.
      const retyped = yield* deployEntry("4", [
        { policyArn: viewPolicyArn, accessScope: { type: "cluster" } },
        { policyArn: editPolicyArn, accessScope: { type: "namespace", namespaces: ["a", "b"] } },
        { policyArn: adminPolicyArn, accessScope: { type: "cluster" } },
      ]);
      expect(yield* associated(retyped)).toEqual({
        [viewPolicyArn]: clusterScope,
        [editPolicyArn]: { type: "namespace", namespaces: ["a", "b"] },
        [adminPolicyArn]: clusterScope,
      });

      // A policy disassociated out of band is restored on the next reconcile.
      yield* eks.disassociateAccessPolicy({
        clusterName: retyped.clusterName,
        principalArn: retyped.principalArn,
        policyArn: viewPolicyArn,
      });
      const restored = yield* deployEntry("5", [
        { policyArn: viewPolicyArn, accessScope: { type: "cluster" } },
        { policyArn: editPolicyArn, accessScope: { type: "namespace", namespaces: ["a", "b"] } },
        { policyArn: adminPolicyArn, accessScope: { type: "cluster" } },
      ]);
      expect(yield* associated(restored)).toEqual({
        [viewPolicyArn]: clusterScope,
        [editPolicyArn]: { type: "namespace", namespaces: ["a", "b"] },
        [adminPolicyArn]: clusterScope,
      });

      // Removing policies disassociates only those policies.
      const trimmed = yield* deployEntry("6", [
        { policyArn: viewPolicyArn, accessScope: { type: "cluster" } },
      ]);
      expect(yield* associated(trimmed)).toEqual({ [viewPolicyArn]: clusterScope });

      // Omitting `accessPolicies` disassociates every policy.
      const emptied = yield* deployEntry("7");
      expect(yield* associated(emptied)).toEqual({});
      expect(emptied.accessPolicies).toEqual([]);

      // Groups and a username set in props are applied.
      const named = yield* deployEntry("8", [], {
        kubernetesGroups: ["group-b", "group-a"],
        username: "deployer",
      });
      const namedEntry = yield* described(named);
      expect([...(namedEntry.kubernetesGroups ?? [])].sort()).toEqual(["group-a", "group-b"]);
      expect(namedEntry.username).toBe("deployer");

      // Groups are a set: the same groups in another order are not rewritten.
      // EKS stores groups in the order given and bumps `modifiedAt` only when
      // an update changes the entry.
      const reordered = yield* deployEntry("9", [], {
        kubernetesGroups: ["group-a", "group-b"],
        username: "deployer",
      });
      expect((yield* described(reordered)).modifiedAt).toEqual(namedEntry.modifiedAt);

      // Removing the username resets it to the EKS-generated default.
      const unnamed = yield* deployEntry("10", [], {
        kubernetesGroups: ["group-a", "group-b"],
      });
      expect((yield* described(unnamed)).username).toContain(":assumed-role/");

      // A group change still applies.
      const regrouped = yield* deployEntry("11", [], { kubernetesGroups: ["group-a"] });
      expect((yield* described(regrouped)).kubernetesGroups).toEqual(["group-a"]);

      yield* stack.destroy();

      const gone = yield* eks.describeCluster({ name: emptied.clusterName }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }),
  {
    tags: ["provider:aws", "provider:aws:eks", "provider:aws:ec2", "provider:aws:iam", "live"],
    // Auto Mode cluster create (~10 min) + eleven reconciles + delete (~5 min).
    timeout: 2_700_000,
  },
);

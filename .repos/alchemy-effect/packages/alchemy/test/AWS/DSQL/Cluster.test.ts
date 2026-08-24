import * as AWS from "@/AWS";
import { Cluster, ClusterPolicy } from "@/AWS/DSQL";
import * as Test from "@/Test/Alchemy";
import * as dsql from "@distilled.cloud/aws/dsql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

/** Docs-canonical policy: deny non-VPC connections. */
const vpcOnlyPolicy = (exceptions?: string[]) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyNonVpcConnect",
        Effect: "Deny",
        Principal: { AWS: "*" },
        Action: ["dsql:DbConnect", "dsql:DbConnectAdmin"],
        Resource: "*",
        Condition: {
          Null: { "aws:SourceVpc": "true" },
          ...(exceptions
            ? { StringNotEquals: { "aws:PrincipalArn": exceptions } }
            : {}),
        },
      },
    ],
  });

const getCluster = (identifier: string) =>
  dsql
    .getCluster({ identifier })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

test.provider(
  "create, update deletion protection, delete DSQL cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // create (deletion protection off for test economics)
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("AppDb", {
            tags: { app: "alchemy-test" },
          });
        }),
      );

      expect(created.clusterId).toBeDefined();
      expect(created.clusterArn).toContain(`:cluster/${created.clusterId}`);
      expect(["ACTIVE", "IDLE"]).toContain(created.status);
      expect(created.endpoint).toContain(created.clusterId);
      expect(created.deletionProtectionEnabled).toBe(false);

      // out-of-band verification
      const observed = yield* getCluster(created.clusterId);
      expect(observed?.identifier).toEqual(created.clusterId);
      expect(observed?.deletionProtectionEnabled).toBe(false);

      // update: enable deletion protection
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("AppDb", {
            deletionProtectionEnabled: true,
            tags: { app: "alchemy-test" },
          });
        }),
      );
      expect(updated.clusterId).toEqual(created.clusterId);
      const reobserved = yield* getCluster(created.clusterId);
      expect(reobserved?.deletionProtectionEnabled).toBe(true);

      // attach a resource-based cluster policy (singleton sub-resource)
      const withPolicy = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("AppDb", {
            deletionProtectionEnabled: true,
            tags: { app: "alchemy-test" },
          });
          const policy = yield* ClusterPolicy("AppDbPolicy", {
            clusterId: cluster.clusterId,
            policy: vpcOnlyPolicy(),
          });
          return {
            clusterId: cluster.clusterId,
            policyVersion: policy.policyVersion,
          };
        }),
      );
      expect(withPolicy.clusterId).toEqual(created.clusterId);
      expect(withPolicy.policyVersion).toBeDefined();

      // out-of-band verification of the attached document
      const attached = yield* dsql.getClusterPolicy({
        identifier: created.clusterId,
      });
      expect(attached.policy).toContain("DenyNonVpcConnect");
      expect(attached.policyVersion).toEqual(withPolicy.policyVersion);

      // update the policy document in place (version bumps)
      const policyUpdated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("AppDb", {
            deletionProtectionEnabled: true,
            tags: { app: "alchemy-test" },
          });
          const policy = yield* ClusterPolicy("AppDbPolicy", {
            clusterId: cluster.clusterId,
            policy: vpcOnlyPolicy([
              "arn:aws:iam::123456789012:role/ExceptionRole",
            ]),
          });
          return { policyVersion: policy.policyVersion };
        }),
      );
      expect(policyUpdated.policyVersion).not.toEqual(withPolicy.policyVersion);
      const reattached = yield* dsql.getClusterPolicy({
        identifier: created.clusterId,
      });
      expect(reattached.policy).toContain("ExceptionRole");

      // delete (provider disables deletion protection automatically)
      yield* stack.destroy();
      const gone = yield* getCluster(created.clusterId);
      // A deleted DSQL cluster is either gone or reports DELETING/DELETED.
      expect(
        gone === undefined ||
          gone.status === "DELETING" ||
          gone.status === "DELETED",
      ).toBe(true);
    }),
  { timeout: 300_000 },
);

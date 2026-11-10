import * as AWS from "@alchemy.run/aws";
import { Cluster } from "@alchemy.run/aws/ECS/Cluster";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as iam from "@distilled.cloud/aws/iam";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection): deploy a real
// cluster, resolve the provider from context via the typed `findProvider`, call
// `list()`, and assert the deployed cluster appears in the exhaustively-
// paginated result (listClusters -> describeClusters hydration).
test.provider(
  "list enumerates the deployed cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const cluster = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("ListCluster", { clusterName: "alchemy-test-ecs-cluster-list" });
        }),
      );

      const provider = yield* Provider.findProvider(Cluster);
      const all = yield* provider.list();

      expect(all.some((c) => c.clusterArn === cluster.clusterArn)).toBe(true);

      yield* stack.destroy();

      // Out-of-band gone-proof: a deleted cluster is INACTIVE (or absent).
      const after = yield* ecs.describeClusters({ clusters: ["alchemy-test-ecs-cluster-list"] });
      expect((after.clusters ?? []).some((c) => c.status === "ACTIVE")).toBe(false);

      // ECS can keep the terminal INACTIVE record discoverable for a while.
      // Provider inventory (and therefore nuke) must treat it as deleted.
      const afterList = yield* provider.list();
      expect(afterList.some((c) => c.clusterArn === cluster.clusterArn)).toBe(false);
    }),
  { tags: ["provider:aws", "provider:aws:ecs", "live"] },
);

// #1968: ECS fills in account-default settings (containerInsights) the props
// never declared; an untouched cluster must not read as drifted.
test.provider(
  "an untouched cluster reports no drift",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("DriftCluster", {});
        }),
      );

      const result = yield* Drift.detect({ name: stack.name, stage: stack.stage }).pipe(
        Effect.provide(stack.state),
      );
      expect(result.resources.DriftCluster?.action).toBe("unchanged");
      expect(result.resources.DriftCluster?.attr.settings).not.toEqual([]);

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:ecs", "live"] },
);

// Regression for #1558: in an account that has never run ECS, CreateCluster
// creates the AWSServiceRoleForECS service-linked role asynchronously, and the
// immediate PutClusterCapacityProviders failed with "Unable to assume the
// service linked role". Delete the role out of band to recreate the fresh-
// account state, then deploy a cluster with capacity providers.
test.provider(
  "attaches capacity providers when the ECS service-linked role does not exist yet",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deletion = yield* iam
        .deleteServiceLinkedRole({ RoleName: "AWSServiceRoleForECS" })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.succeed(undefined)));
      if (deletion) {
        const { Status, Reason } = yield* iam
          .getServiceLinkedRoleDeletionStatus({ DeletionTaskId: deletion.DeletionTaskId })
          .pipe(
            // The deletion task is not readable immediately after it starts.
            Effect.retry({
              while: (e) => e._tag === "NoSuchEntityException",
              schedule: Schedule.spaced("2 seconds"),
              times: 10,
            }),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: ({ Status }) => Status === "SUCCEEDED" || Status === "FAILED",
              times: 30,
            }),
          );
        // IAM refuses to delete the role while any ECS resource in the
        // account still uses it; the deploy below still has to converge.
        if (Status !== "SUCCEEDED") {
          yield* Effect.logWarning(
            `AWSServiceRoleForECS deletion ${Status}; fresh-account state not reproduced`,
            Reason,
          );
        }
      }

      const cluster = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("FreshAccountCluster", {
            capacityProviders: ["FARGATE", "FARGATE_SPOT"],
            defaultCapacityProviderStrategy: [{ capacityProvider: "FARGATE_SPOT", weight: 1 }],
          });
        }),
      );

      const observed = (yield* ecs.describeClusters({ clusters: [cluster.clusterArn] }))
        .clusters?.[0];
      expect(observed?.status).toBe("ACTIVE");
      expect([...(observed?.capacityProviders ?? [])].sort()).toEqual(["FARGATE", "FARGATE_SPOT"]);
      expect(observed?.defaultCapacityProviderStrategy?.[0]?.capacityProvider).toBe("FARGATE_SPOT");

      yield* stack.destroy();

      const after = yield* ecs.describeClusters({ clusters: [cluster.clusterArn] });
      expect((after.clusters ?? []).some((c) => c.status === "ACTIVE")).toBe(false);
    }),
  {
    tags: ["provider:aws", "provider:aws:ecs", "live"],
    exclusive: "aws:ecs-service-linked-role",
    timeout: 240_000,
  },
);

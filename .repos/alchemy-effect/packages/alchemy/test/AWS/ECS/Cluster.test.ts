import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection): deploy a real
// cluster, resolve the provider from context via the typed `findProvider`, call
// `list()`, and assert the deployed cluster appears in the exhaustively-
// paginated result (listClusters -> describeClusters hydration).
test.provider("list enumerates the deployed cluster", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const cluster = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cluster("ListCluster", {
          clusterName: "alchemy-test-ecs-cluster-list",
        });
      }),
    );

    const provider = yield* Provider.findProvider(Cluster);
    const all = yield* provider.list();

    expect(all.some((c) => c.clusterArn === cluster.clusterArn)).toBe(true);

    yield* stack.destroy();

    // Out-of-band gone-proof: a deleted cluster is INACTIVE (or absent).
    const after = yield* ecs.describeClusters({
      clusters: ["alchemy-test-ecs-cluster-list"],
    });
    expect((after.clusters ?? []).some((c) => c.status === "ACTIVE")).toBe(
      false,
    );

    // ECS can keep the terminal INACTIVE record discoverable for a while.
    // Provider inventory (and therefore nuke) must treat it as deleted.
    const afterList = yield* provider.list();
    expect(afterList.some((c) => c.clusterArn === cluster.clusterArn)).toBe(
      false,
    );
  }),
);

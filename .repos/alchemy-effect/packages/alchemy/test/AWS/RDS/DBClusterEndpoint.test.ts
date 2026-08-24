import * as AWS from "@/AWS";
import { DBClusterEndpoint } from "@/AWS/RDS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Read-only `list()` path (default): resolve the provider from context via the
// typed `Provider.findProvider`, call `list()`, and assert a well-typed
// `Attributes[]` is returned. No deploy — spinning up an Aurora cluster + custom
// endpoint takes many minutes, far beyond the 240s budget. The account likely
// has zero custom cluster endpoints, so the array is typically empty; we only
// assert shape correctness here.
test.provider("list returns typed custom cluster endpoints", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DBClusterEndpoint);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const endpoint of all) {
      expect(typeof endpoint.dbClusterEndpointIdentifier).toBe("string");
      expect(Array.isArray(endpoint.staticMembers)).toBe(true);
      expect(Array.isArray(endpoint.excludedMembers)).toBe(true);
      expect(typeof endpoint.tags).toBe("object");
    }
  }),
);

// Full deploy-based `list()` verification, gated behind an env var because
// provisioning an Aurora DB cluster and a custom endpoint takes many minutes.
// Run with AWS_TEST_RDS_DBCLUSTER_ENDPOINT=1 on an account willing to pay the
// provisioning cost.
test.provider.skipIf(!process.env.AWS_TEST_RDS_DBCLUSTER_ENDPOINT)(
  "list enumerates the deployed custom cluster endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const endpoint = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* AWS.RDS.DBCluster("ListCluster", {
            engine: "aurora-postgresql",
            masterUsername: "alchemy",
            manageMasterUserPassword: true,
          });
          return yield* DBClusterEndpoint("ListEndpoint", {
            dbClusterIdentifier: cluster.dbClusterIdentifier,
            endpointType: "READER",
          });
        }),
      );

      const provider = yield* Provider.findProvider(DBClusterEndpoint);
      const all = yield* provider.list();

      expect(
        all.some(
          (e) =>
            e.dbClusterEndpointIdentifier ===
            endpoint.dbClusterEndpointIdentifier,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }),
);

import * as AWS from "@/AWS";
import { PodIdentityAssociation } from "@/AWS/EKS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated probe: `list()` enumerates every cluster, lists each cluster's pod
// identity associations, then hydrates each via `describePodIdentityAssociation`.
// It requires no deployed resource — in a clean account/region it returns `[]`,
// otherwise a well-formed array of full PodIdentityAssociation Attributes. This
// proves the enumeration wiring (listClusters -> listPodIdentityAssociations ->
// describePodIdentityAssociation) compiles and runs live without needing a
// ~10-minute cluster create.
test.provider(
  "list returns a well-formed array of pod identity associations",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(PodIdentityAssociation);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const association of all) {
        expect(typeof association.associationArn).toBe("string");
        expect(typeof association.associationId).toBe("string");
        expect(typeof association.clusterName).toBe("string");
        expect(typeof association.namespace).toBe("string");
        expect(typeof association.serviceAccount).toBe("string");
        expect(typeof association.roleArn).toBe("string");
      }
    }),
);

// Full deploy test: an EKS cluster takes ~10+ minutes to provision, which is far
// too heavy for CI. Gate the deploy behind a pre-existing cluster supplied via
// AWS_TEST_EKS_CLUSTER; an entitled account with a standing cluster runs this
// unchanged. Deploys an association, asserts it appears in the
// exhaustively-paginated `list()`, then tears down.
test.provider.skipIf(!process.env.AWS_TEST_EKS_CLUSTER)(
  "list enumerates the deployed pod identity association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const clusterName = process.env.AWS_TEST_EKS_CLUSTER!;
      const roleArn = process.env.AWS_TEST_EKS_POD_ROLE_ARN!;

      const association = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PodIdentityAssociation("ListPodIdentity", {
            clusterName,
            namespace: "default",
            serviceAccount: "alchemy-test-list-sa",
            roleArn,
          });
        }),
      );

      const provider = yield* Provider.findProvider(PodIdentityAssociation);
      const all = yield* provider.list();

      expect(
        all.some((a) => a.associationId === association.associationId),
      ).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 600_000 },
);

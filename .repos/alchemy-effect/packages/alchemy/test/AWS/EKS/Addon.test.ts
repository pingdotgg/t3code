import * as AWS from "@/AWS";
import { Addon } from "@/AWS/EKS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated probe: `list()` enumerates every cluster, lists each cluster's
// add-ons, then hydrates each via `describeAddon`. It requires no deployed
// resource — in a clean account/region it returns `[]`, otherwise a
// well-formed array of full Add-on Attributes. This proves the enumeration
// wiring (listClusters -> listAddons -> describeAddon) compiles and runs live
// without needing a ~10-minute cluster create.
test.provider("list returns a well-formed array of add-ons", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(Addon);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const addon of all) {
      expect(typeof addon.addonArn).toBe("string");
      expect(typeof addon.addonName).toBe("string");
      expect(typeof addon.clusterName).toBe("string");
    }
  }),
);

// Full deploy test: an EKS cluster takes ~10+ minutes to provision, which is
// far too heavy for CI. Gate the deploy behind a pre-existing cluster supplied
// via AWS_TEST_EKS_CLUSTER; an entitled account with a standing cluster runs
// this unchanged. Deploys `metrics-server`, asserts it appears in the
// exhaustively-paginated `list()`, then tears down.
test.provider.skipIf(!process.env.AWS_TEST_EKS_CLUSTER)(
  "list enumerates the deployed add-on",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const clusterName = process.env.AWS_TEST_EKS_CLUSTER!;

      const addon = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Addon("ListAddon", {
            clusterName,
            addonName: "metrics-server",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Addon);
      const all = yield* provider.list();

      expect(
        all.some(
          (a) =>
            a.clusterName === addon.clusterName &&
            a.addonName === addon.addonName,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 600_000 },
);

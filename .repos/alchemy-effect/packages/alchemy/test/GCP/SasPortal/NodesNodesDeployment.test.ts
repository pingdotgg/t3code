import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as sasportal from "@distilled.cloud/gcp/sasportal_v1alpha1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { firstCustomerName, logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  sasportal.getNodesDeployments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 8,
    }),
  );

test.provider(
  "getNodesDeployments on a missing deployment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sasportal.getNodesDeployments({
          name: "nodes/missing/nodes/missing/deployments/alchemy-missing",
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sasportal", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createNodesNodesDeployments without entitlement fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sasportal.createNodesNodesDeployments({
          parent: "nodes/missing/nodes/missing",
          body: { displayName: "alchemy-sasportal-probe" },
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sasportal", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a nested deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const customer = yield* firstCustomerName;
      expect(customer.length).toBeGreaterThan(0);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* GCP.SasPortal.CustomersNode("Site", {
            parent: customer,
            displayName: "campus",
          });
          const child = yield* GCP.SasPortal.NodesNode("Sector", {
            parent: parent.name,
            displayName: "sector-1",
          });
          const deployment = yield* GCP.SasPortal.NodesNodesDeployment(
            "Campus",
            {
              parent: child.name,
              displayName: "downtown",
            },
          );
          return { parent, child, deployment };
        }),
      );

      expect(created.deployment.name.length).toBeGreaterThan(0);
      expect(created.deployment.displayName).toEqual("downtown");

      const fetched = yield* sasportal.getNodesDeployments({
        name: created.deployment.name,
      });
      expect(fetched.name).toEqual(created.deployment.name);
      expect(fetched.displayName).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* GCP.SasPortal.CustomersNode("Site", {
            parent: customer,
            name: created.parent.name,
            displayName: "campus",
          });
          const child = yield* GCP.SasPortal.NodesNode("Sector", {
            parent: parent.name,
            name: created.child.name,
            displayName: "sector-1",
          });
          const deployment = yield* GCP.SasPortal.NodesNodesDeployment(
            "Campus",
            {
              parent: child.name,
              name: created.deployment.name,
              displayName: "downtown-west",
            },
          );
          return { parent, child, deployment };
        }),
      );

      expect(updated.deployment.name).toEqual(created.deployment.name);
      expect(updated.deployment.displayName).toEqual("downtown-west");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.deployment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sasportal", "live"], timeout: 90_000 },
);

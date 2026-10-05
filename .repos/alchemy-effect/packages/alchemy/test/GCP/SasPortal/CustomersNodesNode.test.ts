import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as sasportal from "@distilled.cloud/gcp/sasportal_v1alpha1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { firstCustomerName, logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  sasportal.getNodesNodes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 8,
    }),
  );

test.provider(
  "getNodesNodes on a missing node fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sasportal.getNodesNodes({
          name: "customers/missing/nodes/missing/nodes/alchemy-missing",
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sasportal", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createCustomersNodesNodes without entitlement fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sasportal.createCustomersNodesNodes({
          parent: "customers/missing/nodes/missing",
          body: { displayName: "alchemy-sasportal-probe" },
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sasportal", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a nested node",
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
          const child = yield* GCP.SasPortal.CustomersNodesNode("Sector", {
            parent: parent.name,
            displayName: "sector-1",
          });
          return { parent, child };
        }),
      );

      expect(created.child.name.length).toBeGreaterThan(0);
      expect(created.child.displayName).toEqual("sector-1");

      const fetched = yield* sasportal.getNodesNodes({
        name: created.child.name,
      });
      expect(fetched.name).toEqual(created.child.name);
      expect(fetched.displayName).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* GCP.SasPortal.CustomersNode("Site", {
            parent: customer,
            name: created.parent.name,
            displayName: "campus",
          });
          const child = yield* GCP.SasPortal.CustomersNodesNode("Sector", {
            parent: parent.name,
            name: created.child.name,
            displayName: "sector-2",
          });
          return { parent, child };
        }),
      );

      expect(updated.child.name).toEqual(created.child.name);
      expect(updated.child.displayName).toEqual("sector-2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.child.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sasportal", "live"], timeout: 90_000 },
);

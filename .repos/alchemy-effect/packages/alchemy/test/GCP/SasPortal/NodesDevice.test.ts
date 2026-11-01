import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as sasportal from "@distilled.cloud/gcp/sasportal_v1alpha1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { firstCustomerName, logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  sasportal.getNodesDevices({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getNodesDevices on a missing device fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sasportal.getNodesDevices({
          name: "nodes/missing/devices/alchemy-missing",
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sasportal", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createNodesDevices without entitlement fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sasportal.createNodesDevices({
          parent: "nodes/missing",
          body: {
            displayName: "alchemy-sasportal-probe",
            fccId: "TESTFCC",
            serialNumber: "ALCHEMYPROBE2",
          },
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sasportal", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a node device",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const customer = yield* firstCustomerName;
      expect(customer.length).toBeGreaterThan(0);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const node = yield* GCP.SasPortal.CustomersNode("Site", {
            parent: customer,
            displayName: "site-a",
          });
          const device = yield* GCP.SasPortal.NodesDevice("Cbsd", {
            parent: node.name,
            displayName: "sector-a",
            fccId: "TESTFCC",
            serialNumber: "ALCHSN2001",
          });
          return { node, device };
        }),
      );

      expect(created.device.name.length).toBeGreaterThan(0);
      expect(created.device.parent).toEqual(created.node.name);
      expect(created.device.displayName).toEqual("sector-a");

      const fetched = yield* sasportal.getNodesDevices({
        name: created.device.name,
      });
      expect(fetched.name).toEqual(created.device.name);
      expect(fetched.displayName).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const node = yield* GCP.SasPortal.CustomersNode("Site", {
            parent: customer,
            name: created.node.name,
            displayName: "site-a",
          });
          const device = yield* GCP.SasPortal.NodesDevice("Cbsd", {
            parent: node.name,
            name: created.device.name,
            displayName: "sector-b",
            fccId: "TESTFCC",
            serialNumber: "ALCHSN2001",
          });
          return { node, device };
        }),
      );

      expect(updated.device.name).toEqual(created.device.name);
      expect(updated.device.displayName).toEqual("sector-b");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.device.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sasportal", "live"], timeout: 90_000 },
);

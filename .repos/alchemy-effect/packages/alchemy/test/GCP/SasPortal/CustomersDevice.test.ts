import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as sasportal from "@distilled.cloud/gcp/sasportal_v1alpha1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { firstCustomerName, logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  sasportal.getCustomersDevices({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getCustomersDevices on a missing device fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sasportal.getCustomersDevices({
          name: "customers/missing/devices/alchemy-missing",
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sasportal", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createCustomersDevices without entitlement fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sasportal.createCustomersDevices({
          parent: "customers/missing",
          body: {
            displayName: "alchemy-sasportal-probe",
            fccId: "TESTFCC",
            serialNumber: "ALCHEMYPROBE1",
          },
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sasportal", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a customer device",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* firstCustomerName;
      expect(parent.length).toBeGreaterThan(0);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SasPortal.CustomersDevice("Cbsd", {
            parent,
            displayName: "rooftop-1",
            fccId: "TESTFCC",
            serialNumber: "ALCHSN1001",
          });
        }),
      );

      expect(created.name.length).toBeGreaterThan(0);
      expect(created.parent).toEqual(parent);
      expect(created.displayName).toEqual("rooftop-1");
      expect(created.fccId).toEqual("TESTFCC");

      const fetched = yield* sasportal.getCustomersDevices({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SasPortal.CustomersDevice("Cbsd", {
            parent,
            name: created.name,
            displayName: "rooftop-2",
            fccId: "TESTFCC",
            serialNumber: "ALCHSN1001",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("rooftop-2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sasportal", "live"], timeout: 90_000 },
);

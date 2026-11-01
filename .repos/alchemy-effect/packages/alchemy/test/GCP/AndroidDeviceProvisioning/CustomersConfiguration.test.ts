import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as androiddeviceprovisioning from "@distilled.cloud/gcp/androiddeviceprovisioning_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  customerName,
  logLevel,
  probeName,
  probeParent,
  resolveDpc,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!runLifecycle)(
  "getCustomersConfigurations on a missing configuration fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androiddeviceprovisioning.getCustomersConfigurations({
          name: probeName,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androiddeviceprovisioning", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createCustomersConfigurations without zero-touch access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androiddeviceprovisioning.createCustomersConfigurations({
          parent: probeParent,
          body: {
            configurationName: "Alchemy Probe",
            dpcResourcePath: `${probeParent}/dpcs/0`,
            companyName: "Alchemy",
            contactEmail: "alchemy-test@example.com",
            contactPhone: "+1 555 0100",
            isDefault: false,
          },
        }),
      );
      expect(error._tag).toEqual("InsufficientAuthenticationScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androiddeviceprovisioning", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = customerName!;
      const dpcResourcePath = yield* resolveDpc(parent);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AndroidDeviceProvisioning.CustomersConfiguration(
            "Sales",
            {
              parent,
              dpcResourcePath,
              companyName: "Alchemy",
              contactEmail: "alchemy-test@example.com",
              contactPhone: "+1 555 0100",
              configurationName: "Sales team",
              isDefault: false,
            },
          );
        }),
      );

      expect(created.name).toContain("/configurations/");
      expect(created.parent).toEqual(parent);
      expect(created.configurationId.length).toBeGreaterThan(0);
      expect(created.configurationName).toEqual("Sales team");
      expect(created.companyName).toEqual("Alchemy");
      expect(created.contactEmail).toEqual("alchemy-test@example.com");
      expect(created.isDefault).toEqual(false);

      const fetched =
        yield* androiddeviceprovisioning.getCustomersConfigurations({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.configurationName).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AndroidDeviceProvisioning.CustomersConfiguration(
            "Sales",
            {
              parent: created.parent,
              configurationId: created.configurationId,
              dpcResourcePath: created.dpcResourcePath ?? dpcResourcePath,
              companyName: created.companyName ?? "Alchemy",
              contactEmail: "help@example.com",
              contactPhone: created.contactPhone ?? "+1 555 0100",
              configurationName: "Field sales",
              customMessage: "Contact IT for setup help.",
              isDefault: false,
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.configurationName).toEqual("Field sales");
      expect(updated.contactEmail).toEqual("help@example.com");
      expect(updated.customMessage).toEqual("Contact IT for setup help.");

      const fetchedUpdate =
        yield* androiddeviceprovisioning.getCustomersConfigurations({
          name: updated.name,
        });
      expect(fetchedUpdate.configurationName).toContain("Field sales");
      expect(fetchedUpdate.contactEmail).toEqual("help@example.com");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androiddeviceprovisioning", "live"],
    timeout: 90_000,
  },
);

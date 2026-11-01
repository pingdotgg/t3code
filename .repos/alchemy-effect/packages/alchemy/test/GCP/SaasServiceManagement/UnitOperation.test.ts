import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as saasservicemgmt from "@distilled.cloud/gcp/saasservicemgmt_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  location,
  logLevel,
  currentProject,
  blueprintPackage,
  runBlueprintLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsUnitOperations on a missing unit operation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        saasservicemgmt.getProjectsLocationsUnitOperations({
          name: `projects/${project}/locations/${location}/unitOperations/alchemy-missing-uop`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:saasservicemgmt", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runBlueprintLifecycle)(
  "create, update, and delete a unit operation",
  (stack) =>
    Effect.gen(function* () {
      const blueprint = blueprintPackage ?? "";
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.SaasServiceManagement.Saa("Inventory", {
            location,
            locations: [{ name: location }],
          });
          const tenant = yield* GCP.SaasServiceManagement.Tenant("Acme", {
            location,
            saas: product.name,
          });
          const kind = yield* GCP.SaasServiceManagement.UnitKind("Store", {
            location,
            saas: product.name,
          });
          const release = yield* GCP.SaasServiceManagement.Release("V1", {
            location,
            unitKind: kind.name,
            blueprint: { package: blueprint },
          });
          const unit = yield* GCP.SaasServiceManagement.Unit("Store1", {
            location,
            unitKind: kind.name,
            tenant: tenant.name,
            managementMode: "MANAGEMENT_MODE_USER",
          });
          const operation = yield* GCP.SaasServiceManagement.UnitOperation(
            "Provision",
            {
              location,
              unit: unit.name,
              provision: { release: release.name },
              labels: { env: "test" },
            },
          );
          return { product, tenant, kind, release, unit, operation };
        }),
      );

      expect(created.operation.name).toContain("/unitOperations/");
      expect(created.operation.unitId).toEqual(created.unit.unitId);
      expect(created.operation.labels).toMatchObject({ env: "test" });

      const fetched = yield* saasservicemgmt.getProjectsLocationsUnitOperations(
        {
          name: created.operation.name,
        },
      );
      expect(fetched.name).toEqual(created.operation.name);
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.SaasServiceManagement.Saa("Inventory", {
            saasId: created.product.saasId,
            location,
            locations: [{ name: location }],
          });
          const tenant = yield* GCP.SaasServiceManagement.Tenant("Acme", {
            tenantId: created.tenant.tenantId,
            location,
            saas: product.name,
          });
          const kind = yield* GCP.SaasServiceManagement.UnitKind("Store", {
            unitKindId: created.kind.unitKindId,
            location,
            saas: product.name,
          });
          const release = yield* GCP.SaasServiceManagement.Release("V1", {
            releaseId: created.release.releaseId,
            location,
            unitKind: kind.name,
            blueprint: { package: blueprint },
          });
          const unit = yield* GCP.SaasServiceManagement.Unit("Store1", {
            unitId: created.unit.unitId,
            location,
            unitKind: kind.name,
            tenant: tenant.name,
            managementMode: "MANAGEMENT_MODE_USER",
          });
          const operation = yield* GCP.SaasServiceManagement.UnitOperation(
            "Provision",
            {
              unitOperationId: created.operation.unitOperationId,
              location,
              unit: unit.name,
              provision: { release: release.name },
              labels: { env: "prod" },
            },
          );
          return { product, tenant, kind, release, unit, operation };
        }),
      );

      expect(updated.operation.name).toEqual(created.operation.name);
      expect(updated.operation.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        saasservicemgmt.getProjectsLocationsUnitOperations({
          name: created.operation.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:saasservicemgmt", "live"],
    timeout: 90_000,
  },
);

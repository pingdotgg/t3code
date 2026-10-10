import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as saasservicemgmt from "@distilled.cloud/gcp/saasservicemgmt_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  location,
  logLevel,
  currentProject,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsUnits on a missing unit fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        saasservicemgmt.getProjectsLocationsUnits({
          name: `projects/${project}/locations/${location}/units/alchemy-missing-unit`,
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

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a unit",
  (stack) =>
    Effect.gen(function* () {
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
          const unit = yield* GCP.SaasServiceManagement.Unit("Store1", {
            location,
            unitKind: kind.name,
            tenant: tenant.name,
            managementMode: "MANAGEMENT_MODE_USER",
            labels: { env: "test" },
          });
          return { product, tenant, kind, unit };
        }),
      );

      expect(created.unit.name).toContain("/units/");
      expect(created.unit.unitKindId).toEqual(created.kind.unitKindId);
      expect(created.unit.tenantId).toEqual(created.tenant.tenantId);
      expect(created.unit.labels).toMatchObject({ env: "test" });

      const fetched = yield* saasservicemgmt.getProjectsLocationsUnits({
        name: created.unit.name,
      });
      expect(fetched.name).toEqual(created.unit.name);
      expect(fetched.labels?.env).toEqual("test");
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
          const unit = yield* GCP.SaasServiceManagement.Unit("Store1", {
            unitId: created.unit.unitId,
            location,
            unitKind: kind.name,
            tenant: tenant.name,
            managementMode: "MANAGEMENT_MODE_USER",
            labels: { env: "prod" },
          });
          return { product, tenant, kind, unit };
        }),
      );

      expect(updated.unit.name).toEqual(created.unit.name);
      expect(updated.unit.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        saasservicemgmt.getProjectsLocationsUnits({ name: created.unit.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:saasservicemgmt", "live"],
    timeout: 90_000,
  },
);

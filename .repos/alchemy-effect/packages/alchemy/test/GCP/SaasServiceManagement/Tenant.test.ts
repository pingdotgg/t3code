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
  "getProjectsLocationsTenants on a missing tenant fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        saasservicemgmt.getProjectsLocationsTenants({
          name: `projects/${project}/locations/${location}/tenants/alchemy-missing-tnt`,
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
  "create, update, and delete a tenant",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.SaasServiceManagement.Saa("Inventory", {
            location,
            locations: [{ name: location }],
            labels: { env: "test" },
          });
          const tenant = yield* GCP.SaasServiceManagement.Tenant("Acme", {
            location,
            saas: product.name,
            labels: { env: "test" },
          });
          return { product, tenant };
        }),
      );

      expect(created.tenant.name).toContain("/tenants/");
      expect(created.tenant.saasId).toEqual(created.product.saasId);
      expect(created.tenant.labels).toMatchObject({ env: "test" });

      const fetched = yield* saasservicemgmt.getProjectsLocationsTenants({
        name: created.tenant.name,
      });
      expect(fetched.name).toEqual(created.tenant.name);
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
            labels: { env: "test" },
          });
          const tenant = yield* GCP.SaasServiceManagement.Tenant("Acme", {
            tenantId: created.tenant.tenantId,
            location,
            saas: product.name,
            labels: { env: "prod", customer: "acme" },
          });
          return { product, tenant };
        }),
      );

      expect(updated.tenant.name).toEqual(created.tenant.name);
      expect(updated.tenant.labels).toMatchObject({
        env: "prod",
        customer: "acme",
      });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        saasservicemgmt.getProjectsLocationsTenants({
          name: created.tenant.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:saasservicemgmt", "live"],
    timeout: 90_000,
  },
);

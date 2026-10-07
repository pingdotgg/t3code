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
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsReleases on a missing release fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        saasservicemgmt.getProjectsLocationsReleases({
          name: `projects/${project}/locations/${location}/releases/alchemy-missing-rel`,
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

test.provider.skipIf(!runLifecycle || runBlueprintLifecycle)(
  "a release with a missing blueprint image fails with BlueprintNotFound",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            const product = yield* GCP.SaasServiceManagement.Saa(
              "MissingProduct",
              {
                location,
                locations: [{ name: location }],
              },
            );
            const kind = yield* GCP.SaasServiceManagement.UnitKind(
              "MissingKind",
              {
                location,
                saas: product.name,
              },
            );
            return yield* GCP.SaasServiceManagement.Release("Missing", {
              location,
              unitKind: kind.name,
              blueprint: {
                package: `${location}-docker.pkg.dev/${project}/alchemy-missing/store:v1`,
              },
            });
          }),
        ),
      );
      expect(error._tag).toEqual("BlueprintNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:saasservicemanagement", "live"],
    timeout: 120_000,
  },
);

test.provider.skipIf(!runBlueprintLifecycle)(
  "create, update, and delete a release",
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
          const kind = yield* GCP.SaasServiceManagement.UnitKind("Store", {
            location,
            saas: product.name,
          });
          const release = yield* GCP.SaasServiceManagement.Release("V1", {
            location,
            unitKind: kind.name,
            blueprint: { package: blueprint },
            labels: { env: "test" },
          });
          return { product, kind, release };
        }),
      );

      expect(created.release.name).toContain("/releases/");
      expect(created.release.unitKindId).toEqual(created.kind.unitKindId);
      expect(created.release.blueprint?.package).toEqual(blueprint);
      expect(created.release.labels).toMatchObject({ env: "test" });

      const fetched = yield* saasservicemgmt.getProjectsLocationsReleases({
        name: created.release.name,
      });
      expect(fetched.name).toEqual(created.release.name);
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
            inputVariableDefaults: [
              { variable: "region", type: "STRING", value: location },
            ],
            labels: { env: "prod" },
          });
          return { product, kind, release };
        }),
      );

      expect(updated.release.name).toEqual(created.release.name);
      expect(updated.release.labels).toMatchObject({ env: "prod" });
      expect(updated.release.inputVariableDefaults[0]?.variable).toEqual(
        "region",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        saasservicemgmt.getProjectsLocationsReleases({
          name: created.release.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:saasservicemgmt", "live"],
    timeout: 90_000,
  },
);

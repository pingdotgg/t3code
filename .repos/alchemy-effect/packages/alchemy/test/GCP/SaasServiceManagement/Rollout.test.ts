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
  "getProjectsLocationsRollouts on a missing rollout fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        saasservicemgmt.getProjectsLocationsRollouts({
          name: `projects/${project}/locations/${location}/rollouts/alchemy-missing-rlo`,
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
  "create, update, and delete a rollout",
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
          });
          const rolloutKind = yield* GCP.SaasServiceManagement.RolloutKind(
            "Wave",
            {
              location,
              unitKind: kind.name,
              rolloutOrchestrationStrategy: "Google.Cloud.Simple.AllAtOnce",
            },
          );
          const rollout = yield* GCP.SaasServiceManagement.Rollout("Wave1", {
            location,
            rolloutKind: rolloutKind.name,
            release: release.name,
            labels: { env: "test" },
          });
          return { product, kind, release, rolloutKind, rollout };
        }),
      );

      expect(created.rollout.name).toContain("/rollouts/");
      expect(created.rollout.releaseId).toEqual(created.release.releaseId);
      expect(created.rollout.labels).toMatchObject({ env: "test" });

      const fetched = yield* saasservicemgmt.getProjectsLocationsRollouts({
        name: created.rollout.name,
      });
      expect(fetched.name).toEqual(created.rollout.name);
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
          });
          const rolloutKind = yield* GCP.SaasServiceManagement.RolloutKind(
            "Wave",
            {
              rolloutKindId: created.rolloutKind.rolloutKindId,
              location,
              unitKind: kind.name,
              rolloutOrchestrationStrategy: "Google.Cloud.Simple.AllAtOnce",
            },
          );
          const rollout = yield* GCP.SaasServiceManagement.Rollout("Wave1", {
            rolloutId: created.rollout.rolloutId,
            location,
            rolloutKind: rolloutKind.name,
            release: release.name,
            labels: { env: "prod" },
          });
          return { product, kind, release, rolloutKind, rollout };
        }),
      );

      expect(updated.rollout.name).toEqual(created.rollout.name);
      expect(updated.rollout.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        saasservicemgmt.getProjectsLocationsRollouts({
          name: created.rollout.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:saasservicemgmt", "live"],
    timeout: 90_000,
  },
);

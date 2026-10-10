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
  "getProjectsLocationsRolloutKinds on a missing rollout kind fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        saasservicemgmt.getProjectsLocationsRolloutKinds({
          name: `projects/${project}/locations/${location}/rolloutKinds/alchemy-missing-rk`,
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
  "create, update, and delete a rollout kind",
  (stack) =>
    Effect.gen(function* () {
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
          const rolloutKind = yield* GCP.SaasServiceManagement.RolloutKind(
            "Wave",
            {
              location,
              unitKind: kind.name,
              rolloutOrchestrationStrategy: "Google.Cloud.Simple.AllAtOnce",
              labels: { env: "test" },
            },
          );
          return { product, kind, rolloutKind };
        }),
      );

      expect(created.rolloutKind.name).toContain("/rolloutKinds/");
      expect(created.rolloutKind.unitKindId).toEqual(created.kind.unitKindId);
      expect(created.rolloutKind.labels).toMatchObject({ env: "test" });

      const fetched = yield* saasservicemgmt.getProjectsLocationsRolloutKinds({
        name: created.rolloutKind.name,
      });
      expect(fetched.name).toEqual(created.rolloutKind.name);
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
          const rolloutKind = yield* GCP.SaasServiceManagement.RolloutKind(
            "Wave",
            {
              rolloutKindId: created.rolloutKind.rolloutKindId,
              location,
              unitKind: kind.name,
              rolloutOrchestrationStrategy: "Google.Cloud.Simple.AllAtOnce",
              errorBudget: { allowedCount: 1, allowedPercentage: 10 },
              labels: { env: "prod" },
            },
          );
          return { product, kind, rolloutKind };
        }),
      );

      expect(updated.rolloutKind.name).toEqual(created.rolloutKind.name);
      expect(updated.rolloutKind.labels).toMatchObject({ env: "prod" });
      expect(updated.rolloutKind.errorBudget?.allowedCount).toEqual(1);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        saasservicemgmt.getProjectsLocationsRolloutKinds({
          name: created.rolloutKind.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:saasservicemgmt", "live"],
    timeout: 90_000,
  },
);

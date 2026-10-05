import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as securityposture from "@distilled.cloud/gcp/securityposture_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  organization,
  runLifecycle,
  updatedPolicySets,
  waitUntilPostureGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!runLifecycle)(
  "getOrganizationsLocationsPostures on a missing posture fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        securityposture.getOrganizationsLocationsPostures({
          name: `${organization}/locations/global/postures/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securityposture", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a posture",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecurityPosture.Posture("Baseline", {
            organization,
            description: "staging baseline",
            annotations: { env: "test" },
          });
        }),
      );

      expect(created.postureId).toEqual(expect.any(String));
      expect(created.organization).toEqual(organization);
      expect(created.location).toEqual("global");
      expect(created.name).toEqual(
        `${organization}/locations/global/postures/${created.postureId}`,
      );
      expect(created.state).toEqual("DRAFT");
      expect(created.description).toEqual("staging baseline");
      expect(created.annotations).toMatchObject({ env: "test" });
      expect(created.policySets.length).toBeGreaterThan(0);
      expect(created.revisionId).toEqual(expect.any(String));

      const fetched = yield* securityposture.getOrganizationsLocationsPostures({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.annotations?.env).toEqual("test");
      expect(fetched.annotations?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecurityPosture.Posture("Baseline", {
            organization,
            postureId: created.postureId,
            description: "updated baseline",
            annotations: { env: "prod" },
            policySets: updatedPolicySets,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated baseline");
      expect(updated.policySets.map((set) => set.policySetId)).toContain(
        "alchemy",
      );
      expect(
        updated.policySets[0]?.policies?.map((policy) => policy.policyId),
      ).toEqual(["alchemy-sha", "alchemy-sha-2"]);

      yield* stack.destroy();

      const gone = yield* waitUntilPostureGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securityposture", "live"],
    timeout: 90_000,
  },
);

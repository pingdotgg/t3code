import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as securityposture from "@distilled.cloud/gcp/securityposture_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  organization,
  runLifecycle,
  waitUntilDeploymentGone,
  waitUntilPostureGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!runLifecycle)(
  "getOrganizationsLocationsPostureDeployments on a missing deployment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        securityposture.getOrganizationsLocationsPostureDeployments({
          name: `${organization}/locations/global/postureDeployments/alchemy-missing`,
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
  "create, update, and delete a posture deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const posture = yield* GCP.SecurityPosture.Posture("Baseline", {
            organization,
            state: "ACTIVE",
            description: "deployable baseline",
            annotations: { env: "test" },
          });
          const deployment = yield* GCP.SecurityPosture.PostureDeployment(
            "Staging",
            {
              organization,
              postureId: posture.name,
              postureRevisionId: posture.revisionId.as<string>(),
              description: "staging deployment",
              annotations: { env: "test" },
            },
          );
          return { posture, deployment };
        }),
      );

      expect(created.posture.state).toEqual("ACTIVE");
      expect(created.posture.revisionId).toEqual(expect.any(String));
      expect(created.deployment.postureDeploymentId).toEqual(
        expect.any(String),
      );
      expect(created.deployment.organization).toEqual(organization);
      expect(created.deployment.name).toEqual(
        `${organization}/locations/global/postureDeployments/${created.deployment.postureDeploymentId}`,
      );
      expect(created.deployment.postureId).toEqual(created.posture.name);
      expect(created.deployment.postureRevisionId).toEqual(
        created.posture.revisionId,
      );
      expect(created.deployment.description).toEqual("staging deployment");
      expect(created.deployment.annotations).toMatchObject({ env: "test" });

      const fetched =
        yield* securityposture.getOrganizationsLocationsPostureDeployments({
          name: created.deployment.name,
        });
      expect(fetched.name).toEqual(created.deployment.name);
      expect(fetched.annotations?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const posture = yield* GCP.SecurityPosture.Posture("Baseline", {
            organization,
            postureId: created.posture.postureId,
            state: "ACTIVE",
            description: "deployable baseline v2",
            annotations: { env: "prod" },
          });
          const deployment = yield* GCP.SecurityPosture.PostureDeployment(
            "Staging",
            {
              organization,
              postureDeploymentId: created.deployment.postureDeploymentId,
              postureId: posture.name,
              postureRevisionId: posture.revisionId.as<string>(),
              description: "staging deployment v2",
              annotations: { env: "prod" },
            },
          );
          return { posture, deployment };
        }),
      );

      expect(updated.deployment.name).toEqual(created.deployment.name);
      expect(updated.deployment.postureId).toEqual(updated.posture.name);
      expect(updated.posture.description).toEqual("deployable baseline v2");

      yield* stack.destroy();

      const deploymentGone = yield* waitUntilDeploymentGone(
        created.deployment.name,
      );
      expect(deploymentGone).toEqual("gone");
      const postureGone = yield* waitUntilPostureGone(created.posture.name);
      expect(postureGone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securityposture", "live"],
    timeout: 120_000,
  },
);

import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const INSTANCE_ID = "alchemy-sthsm-does-not-exist";
const PROPOSAL_ID = "alchemy-test-sthsm-proposal";
const instanceNameOf = (project: string) =>
  `projects/${project}/locations/us-central1/singleTenantHsmInstances/${INSTANCE_ID}`;
const missingProposalNameOf = (project: string) =>
  `${instanceNameOf(project)}/proposals/alchemy-sthsm-proposal-does-not-exist`;

// Creating a SingleTenantHsmInstance succeeds as an LRO then lands in
// FAILED (`quorumAuth` without 2FA registration). Proposals against a
// FAILED instance return BadRequest (`FAILED_PRECONDITION`: "Can not
// create proposal for a FAILED SingleTenantHsmInstance."). A missing
// parent returns NotFound. Set GCP_TEST_KMS_HSM=1 and
// GCP_TEST_KMS_HSM_INSTANCE to a working instance to run the lifecycle.
const runLifecycle =
  !process.env.FAST &&
  process.env.GCP_TEST_KMS_HSM === "1" &&
  !!process.env.GCP_TEST_KMS_HSM_INSTANCE;
const entitledInstance = process.env.GCP_TEST_KMS_HSM_INSTANCE ?? "";

const waitUntilGone = (name: string) =>
  kms.getProjectsLocationsSingleTenantHsmInstancesProposals({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSingleTenantHsmInstancesProposals on a missing proposal fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingProposalName = missingProposalNameOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        kms.getProjectsLocationsSingleTenantHsmInstancesProposals({
          name: missingProposalName,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const gone = yield* waitUntilGone(missingProposalName);
      expect(gone).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:kms", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "create is rejected with NotFound when the parent HSM instance is missing",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const instanceName = instanceNameOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.KMS.SingleTenantHsmInstanceProposal("Refresh", {
              singleTenantHsmInstance: instanceName,
              proposalId: PROPOSAL_ID,
              refreshSingleTenantHsmInstance: true,
            });
          }),
        ),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:kms", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a single-tenant HSM instance proposal",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.KMS.SingleTenantHsmInstanceProposal("Refresh", {
            singleTenantHsmInstance: entitledInstance,
            proposalId: PROPOSAL_ID,
            refreshSingleTenantHsmInstance: true,
          });
        }),
      );

      expect(created.proposalId).toEqual(PROPOSAL_ID);
      expect(created.name).toContain(`/proposals/${PROPOSAL_ID}`);
      expect(created.refreshSingleTenantHsmInstance).toEqual(true);
      expect(created.project).toEqual(project);

      const fetched =
        yield* kms.getProjectsLocationsSingleTenantHsmInstancesProposals({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:kms", "live"], timeout: 90_000 },
);

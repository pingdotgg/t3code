import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as osconfig from "@distilled.cloud/gcp/osconfig_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  osconfig.getOrganizationsLocationsGlobalPolicyOrchestrators({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// The OS Config API is disabled on the testing project (every call fails
// with ServiceDisabled). Set GCP_TEST_OSCONFIG=1 and GOOGLE_ORGANIZATION_ID
// on a project with OS Config enabled and org-level OS Config roles.
const organizationId = process.env.GOOGLE_ORGANIZATION_ID;
const runLifecycle = !!process.env.GCP_TEST_OSCONFIG && !!organizationId;

const organizationOf = () =>
  Effect.succeed(
    organizationId === undefined
      ? ""
      : organizationId.startsWith("organizations/")
        ? organizationId
        : `organizations/${organizationId}`,
  );

test.provider(
  "getOrganizationsLocationsGlobalPolicyOrchestrators on a missing orchestrator fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        osconfig.getOrganizationsLocationsGlobalPolicyOrchestrators({
          name: `${organization}/locations/global/policyOrchestrators/alchemy-missing-orch`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:osconfig", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an organization policy orchestrator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OSConfig.OrganizationsLocationsGlobalPolicyOrchestrator(
            "Debian",
            {
              organizationId: organization,
              description: "org validation",
              labels: { env: "test" },
              state: "STOPPED",
            },
          );
        }),
      );

      expect(created.policyOrchestratorId).toEqual(expect.any(String));
      expect(created.organizationId).toEqual(
        organization.replace("organizations/", ""),
      );
      expect(created.parent).toEqual(`${organization}/locations/global`);
      expect(created.name).toEqual(
        `${organization}/locations/global/policyOrchestrators/${created.policyOrchestratorId}`,
      );
      expect(created.state).toEqual("STOPPED");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* osconfig.getOrganizationsLocationsGlobalPolicyOrchestrators({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OSConfig.OrganizationsLocationsGlobalPolicyOrchestrator(
            "Debian",
            {
              organizationId: organization,
              policyOrchestratorId: created.policyOrchestratorId,
              description: "updated org",
              labels: { env: "prod" },
              state: "STOPPED",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated org");
      expect(updated.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:osconfig", "live"], timeout: 90_000 },
);

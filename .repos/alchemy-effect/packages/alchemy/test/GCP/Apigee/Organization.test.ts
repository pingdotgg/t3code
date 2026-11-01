import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Needs a provisioned Apigee organization on the testing project (paid, or
// ~1h eval provisioning); without one calls fail with ApigeeResourceNotFound (403 "Permission
// denied on resource \"organizations/{project}\" (or it may not exist)").
// Set GCP_TEST_APIGEE_ORG=1 when the org exists.
const runLifecycle = !!process.env.GCP_TEST_APIGEE_ORG;

// Apigee X organizations are 1:1 with the GCP project. Deploying
// GCP.Apigee.Organization against that project would adopt/update (and
// destroy would delete) the account org. Keep lifecycle skipped.
const runOrgLifecycle = false;

const waitUntilGone = (name: string) =>
  apigee.getOrganizations({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("ApigeeResourceNotFound", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getOrganizations on a missing organization fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizations({
          name: "organizations/alchemy-missing-org",
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle || !runOrgLifecycle)(
  "create, update, and delete an organization",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.Organization("Org", {
            displayName: "alchemy-org",
            description: "alchemy test org",
            disableVpcPeering: true,
          });
        }),
      );

      expect(created.organizationId).toEqual(project);
      expect(created.name).toEqual(org);
      expect(created.displayName).toEqual("alchemy-org");
      expect(created.description).toEqual("alchemy test org");

      const fetched = yield* apigee.getOrganizations({
        name: created.name,
      });
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy test org");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.Organization("Org", {
            organizationId: created.organizationId,
            displayName: "alchemy-org-updated",
            description: "updated alchemy test org",
            disableVpcPeering: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-org-updated");
      expect(updated.description).toEqual("updated alchemy test org");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

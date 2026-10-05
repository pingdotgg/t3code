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

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsSpaces({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getOrganizationsSpaces on a missing space fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsSpaces({
          name: `organizations/${project}/spaces/alchemy-apigee-missing-space`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an Apigee space",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.Space("Team", {
            displayName: "alchemy test space",
          });
        }),
      );

      expect(created.spaceId).toEqual(expect.any(String));
      expect(created.organization).toEqual(project);
      expect(created.name).toEqual(
        `organizations/${project}/spaces/${created.spaceId}`,
      );
      expect(created.displayName).toEqual("alchemy test space");

      const fetched = yield* apigee.getOrganizationsSpaces({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.displayName).toContain("alchemy test space");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.Space("Team", {
            spaceId: created.spaceId,
            displayName: "alchemy updated space",
          });
        }),
      );

      expect(updated.spaceId).toEqual(created.spaceId);
      expect(updated.displayName).toEqual("alchemy updated space");

      const fetchedUpdate = yield* apigee.getOrganizationsSpaces({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toContain("alchemy updated space");
      expect(fetchedUpdate.displayName).toContain("alchemy-id=");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as ccaip from "@distilled.cloud/gcp/contactcenteraiplatform_v1alpha1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The Contact Center AI Platform API is not enabled in the testing project.
// Set GCP_TEST_CONTACT_CENTER_AI_PLATFORM=1 on a project where it is; the
// lifecycle also needs GCP_TEST_SLOW (instances take 30–45 minutes).
const entitled = !!process.env.GCP_TEST_CONTACT_CENTER_AI_PLATFORM;
const runLifecycle =
  entitled && !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  ccaip.getProjectsLocationsContactCenters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!entitled)(
  "getProjectsLocationsContactCenters on a missing contact center fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      const missingName = `${parent}/contactCenters/alchemy-missing-cc`;

      yield* stack.destroy();
      const error = yield* Effect.flip(
        ccaip.getProjectsLocationsContactCenters({ name: missingName }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* ccaip.listProjectsLocationsContactCenters({
        parent,
        pageSize: 10,
      });
      expect(
        (page.contactCenters ?? []).map((item) => item.name),
      ).not.toContain(missingName);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenteraiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(entitled)(
  "getProjectsLocationsContactCenters fails with ServiceDisabled while the API is disabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        ccaip.getProjectsLocationsContactCenters({
          name: `projects/${project}/locations/us-central1/contactCenters/alchemy-missing-cc`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenteraiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a contact center",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterAIPlatform.ContactCenter("Support", {
            displayName: "support",
            instanceSize: "DEV_SMALL",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/contactCenters/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("support");
      expect(created.customerDomainPrefix).toEqual(expect.any(String));
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* ccaip.getProjectsLocationsContactCenters({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ContactCenterAIPlatform.ContactCenter("Support", {
            contactCenterId: created.contactCenterId,
            location: created.location,
            customerDomainPrefix: created.customerDomainPrefix,
            displayName: "support-desk",
            instanceSize: "DEV_SMALL",
            labels: { env: "prod", role: "ccaip" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("support-desk");
      expect(updated.labels).toMatchObject({ env: "prod", role: "ccaip" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenteraiplatform", "live"],
    timeout: 3_600_000,
  },
);

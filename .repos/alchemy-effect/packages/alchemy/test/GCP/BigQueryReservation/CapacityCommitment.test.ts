import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bigqueryreservation from "@distilled.cloud/gcp/bigqueryreservation_v1";
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

// Flex commitments are end of sale (create fails with BadRequest, asserted
// by the probe below) and any commitment bills slot-hours. Set
// GCP_TEST_BIGQUERY_CAPACITY_COMMITMENT=1 on a project that can still buy
// flex slots.
const runLifecycle =
  !process.env.FAST &&
  process.env.GCP_TEST_BIGQUERY_CAPACITY_COMMITMENT === "1";

const waitUntilGone = (name: string) =>
  bigqueryreservation.getProjectsLocationsCapacityCommitments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsCapacityCommitments on a missing commitment fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigqueryreservation.getProjectsLocationsCapacityCommitments({
          name: `projects/${project}/locations/us-central1/capacityCommitments/alchemy-bq-capacity-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page =
        yield* bigqueryreservation.listProjectsLocationsCapacityCommitments({
          parent: `projects/${project}/locations/us-central1`,
          pageSize: 10,
        });
      expect(
        (page.capacityCommitments ?? []).map((item) =>
          item.name?.split("/").pop(),
        ),
      ).not.toContain("alchemy-bq-capacity-missing");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigqueryreservation", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "createProjectsLocationsCapacityCommitments flex plans are end of sale or invalid for editions",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigqueryreservation.createProjectsLocationsCapacityCommitments({
          parent: `projects/${project}/locations/us-central1`,
          capacityCommitmentId: "alchemy-bq-capacity-probe",
          body: {
            slotCount: "50",
            plan: "FLEX_FLAT_RATE",
            edition: "ENTERPRISE",
          },
        }),
      );
      expect(error._tag).toEqual("CommitmentPlanNotSupported");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigqueryreservation", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update renewal plan, and delete a flex capacity commitment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQueryReservation.CapacityCommitment("Flex", {
            location: "us-central1",
            slotCount: "50",
            plan: "FLEX_FLAT_RATE",
            edition: "ENTERPRISE",
          });
        }),
      );

      expect(created.name).toContain("/capacityCommitments/");
      expect(created.capacityCommitmentId).toEqual(expect.any(String));
      expect(created.capacityCommitmentId.startsWith("alch-")).toEqual(true);
      expect(created.location).toEqual("us-central1");
      expect(created.slotCount).toEqual("50");
      expect(created.plan).toEqual("FLEX_FLAT_RATE");
      expect(created.edition).toEqual("ENTERPRISE");

      const fetched =
        yield* bigqueryreservation.getProjectsLocationsCapacityCommitments({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.slotCount).toEqual("50");
      expect(fetched.plan).toEqual("FLEX_FLAT_RATE");

      const listed =
        yield* bigqueryreservation.listProjectsLocationsCapacityCommitments({
          parent: `projects/${created.project}/locations/${created.location}`,
        });
      expect(
        (listed.capacityCommitments ?? []).some(
          (item) => item.name === created.name,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQueryReservation.CapacityCommitment("Flex", {
            capacityCommitmentId: created.capacityCommitmentId,
            location: "us-central1",
            slotCount: "50",
            plan: "FLEX_FLAT_RATE",
            edition: "ENTERPRISE",
            renewalPlan: "FLEX_FLAT_RATE",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.plan).toEqual("FLEX_FLAT_RATE");
      expect(
        updated.renewalPlan === "FLEX_FLAT_RATE" ||
          updated.renewalPlan === undefined,
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigqueryreservation", "live"],
    timeout: 120_000,
  },
);

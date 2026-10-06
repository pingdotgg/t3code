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

// Reservation groups need reservation-based fairness on the project;
// otherwise create fails with BadRequest "Can not use Reservation Groups
// without Reservation Based Fairness enabled on the project." Set
// GCP_TEST_BIGQUERY_RESERVATION_GROUPS=1 on such a project.
const runLifecycle =
  !process.env.FAST && process.env.GCP_TEST_BIGQUERY_RESERVATION_GROUPS === "1";

const waitUntilGone = (name: string) =>
  bigqueryreservation.getProjectsLocationsReservationGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsReservationGroups on a missing group fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigqueryreservation.getProjectsLocationsReservationGroups({
          name: `projects/${project}/locations/us-central1/reservationGroups/alchemy-bq-reservation-group-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page =
        yield* bigqueryreservation.listProjectsLocationsReservationGroups({
          parent: `projects/${project}/locations/us-central1`,
          pageSize: 10,
        });
      expect(
        (page.reservationGroups ?? []).map((item) =>
          item.name?.split("/").pop(),
        ),
      ).not.toContain("alchemy-bq-reservation-group-missing");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigqueryreservation", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "createProjectsLocationsReservationGroups is gated on reservation-based fairness",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigqueryreservation.createProjectsLocationsReservationGroups({
          parent: `projects/${project}/locations/us-central1`,
          reservationGroupId: "alchemy-bq-rg-fairness-probe",
          body: {},
        }),
      );
      expect(error._tag).toEqual("ReservationBasedFairnessRequired");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigqueryreservation", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, re-deploy, and delete a reservation group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQueryReservation.ReservationGroup("Team", {
            location: "us-central1",
          });
        }),
      );

      expect(created.name).toContain("/reservationGroups/");
      expect(created.reservationGroupId).toEqual(expect.any(String));
      expect(created.reservationGroupId.startsWith("alch-")).toEqual(true);
      expect(created.location).toEqual("us-central1");

      const fetched =
        yield* bigqueryreservation.getProjectsLocationsReservationGroups({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      const listed =
        yield* bigqueryreservation.listProjectsLocationsReservationGroups({
          parent: `projects/${created.project}/locations/${created.location}`,
        });
      expect(
        (listed.reservationGroups ?? []).some(
          (item) => item.name === created.name,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQueryReservation.ReservationGroup("Team", {
            reservationGroupId: created.reservationGroupId,
            location: "us-central1",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.reservationGroupId).toEqual(created.reservationGroupId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigqueryreservation", "live"],
    timeout: 90_000,
  },
);

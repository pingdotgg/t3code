import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as bigqueryreservation from "@distilled.cloud/gcp/bigqueryreservation_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Reservation groups are free, empty containers. Projects without
// reservation-based fairness reject create with the typed
// `ReservationBasedFairnessRequired` (BadRequest "Can not use Reservation
// Groups without Reservation Based Fairness enabled on the project."); the
// testing project accepts them, so the lifecycle runs by default.

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

      const page = yield* bigqueryreservation.listProjectsLocationsReservationGroups({
        parent: `projects/${project}/locations/us-central1`,
        pageSize: 10,
      });
      expect(
        (page.reservationGroups ?? []).map((item) => item.name?.split("/").pop()),
      ).not.toContain("alchemy-bq-reservation-group-missing");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigqueryreservation", "live"],
    timeout: 90_000,
  },
);

test.provider(
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

      const fetched = yield* bigqueryreservation.getProjectsLocationsReservationGroups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const listed = yield* bigqueryreservation.listProjectsLocationsReservationGroups({
        parent: `projects/${created.project}/locations/${created.location}`,
      });
      expect((listed.reservationGroups ?? []).some((item) => item.name === created.name)).toEqual(
        true,
      );

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

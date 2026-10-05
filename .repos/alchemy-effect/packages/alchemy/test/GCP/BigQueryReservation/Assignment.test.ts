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

const parentOf = (name: string) => name.replace(/\/assignments\/[^/]+$/, "");

const waitUntilGone = (name: string) =>
  bigqueryreservation
    .listProjectsLocationsReservationsAssignments({
      parent: parentOf(name),
      pageSize: 100,
    })
    .pipe(
      Effect.map((page) =>
        (page.assignments ?? []).some((item) => item.name === name)
          ? ("found" as const)
          : ("gone" as const),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "listProjectsLocationsReservationsAssignments on a missing reservation is empty",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      // Listing under a missing reservation answers an empty page.
      const page =
        yield* bigqueryreservation.listProjectsLocationsReservationsAssignments(
          {
            parent: `projects/${project}/locations/us-central1/reservations/alchemy-bq-assignment-missing`,
          },
        );
      expect(page.assignments).toBeUndefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigqueryreservation", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a reservation assignment",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const reservation = yield* GCP.BigQueryReservation.Reservation(
            "Slots",
            {
              location: "us-central1",
              edition: "ENTERPRISE",
              slotCapacity: "0",
            },
          );
          const assignment = yield* GCP.BigQueryReservation.Assignment(
            "Query",
            {
              reservation: reservation.name,
              jobType: "QUERY",
            },
          );
          return { reservation, assignment };
        }),
      );

      expect(created.assignment.name).toContain("/assignments/");
      expect(created.assignment.reservation).toEqual(created.reservation.name);
      expect(created.assignment.jobType).toEqual("QUERY");
      expect(created.assignment.assignee).toContain(`projects/${project}`);

      const listed =
        yield* bigqueryreservation.listProjectsLocationsReservationsAssignments(
          {
            parent: created.reservation.name,
          },
        );
      expect(
        (listed.assignments ?? []).some(
          (item) => item.name === created.assignment.name,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const reservation = yield* GCP.BigQueryReservation.Reservation(
            "Slots",
            {
              reservationId: created.reservation.reservationId,
              location: "us-central1",
              edition: "ENTERPRISE",
              slotCapacity: "0",
            },
          );
          const assignment = yield* GCP.BigQueryReservation.Assignment(
            "Query",
            {
              assignmentId: created.assignment.assignmentId,
              reservation: reservation.name,
              jobType: "QUERY",
              principal: created.assignment.principal,
            },
          );
          return { reservation, assignment };
        }),
      );

      expect(updated.assignment.name).toEqual(created.assignment.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.assignment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigqueryreservation", "live"],
    timeout: 90_000,
  },
);

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

const waitUntilGone = (name: string) =>
  bigqueryreservation.getProjectsLocationsReservations({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsReservations on a missing reservation fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigqueryreservation.getProjectsLocationsReservations({
          name: `projects/${project}/locations/us-central1/reservations/alchemy-bq-reservation-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page = yield* bigqueryreservation.listProjectsLocationsReservations(
        {
          parent: `projects/${project}/locations/us-central1`,
          pageSize: 10,
        },
      );
      expect(
        (page.reservations ?? []).map((item) => item.name?.split("/").pop()),
      ).not.toContain("alchemy-bq-reservation-missing");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigqueryreservation", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a reservation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQueryReservation.Reservation("Slots", {
            location: "us-central1",
            edition: "ENTERPRISE",
            slotCapacity: "0",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/reservations/");
      expect(created.reservationId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.edition).toEqual("ENTERPRISE");
      expect(created.slotCapacity ?? "0").toEqual("0");
      expect(created.ignoreIdleSlots).toEqual(false);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* bigqueryreservation.getProjectsLocationsReservations({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.edition).toEqual("ENTERPRISE");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const listed =
        yield* bigqueryreservation.listProjectsLocationsReservations({
          parent: `projects/${created.project}/locations/${created.location}`,
        });
      expect(
        (listed.reservations ?? []).some((item) => item.name === created.name),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQueryReservation.Reservation("Slots", {
            reservationId: created.reservationId,
            location: "us-central1",
            edition: "ENTERPRISE",
            slotCapacity: "0",
            ignoreIdleSlots: false,
            concurrency: "1",
            labels: { env: "prod", role: "slots" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.ignoreIdleSlots).toEqual(false);
      expect(updated.concurrency).toEqual("1");
      expect(updated.labels).toMatchObject({ env: "prod", role: "slots" });

      const refetched =
        yield* bigqueryreservation.getProjectsLocationsReservations({
          name: created.name,
        });
      expect(refetched.ignoreIdleSlots ?? false).toEqual(false);
      expect(refetched.concurrency).toEqual("1");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("slots");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:bigqueryreservation", "live"],
    timeout: 90_000,
  },
);

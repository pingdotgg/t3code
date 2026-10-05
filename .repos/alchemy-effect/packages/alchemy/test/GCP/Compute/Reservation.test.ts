import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

const zone = "us-central1-a";

const runLifecycle = !process.env.FAST;

const waitUntilGone = (
  projectId: string,
  reservationZone: string,
  reservation: string,
) =>
  compute
    .getReservations({
      project: projectId,
      zone: reservationZone,
      reservation,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getReservations on a missing reservation fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getReservations({
          project,
          zone,
          reservation: "alchemy-missing-reservation",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 300_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a reservation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Reservation("Burst", {
            zone,
            description: "burst capacity",
            specificReservation: {
              count: 1,
              instanceProperties: { machineType: "n1-standard-1" },
            },
            specificReservationRequired: true,
          });
        }),
      );

      expect(created.reservationName).toEqual(expect.any(String));
      expect(created.zone).toEqual(zone);
      expect(created.status).toEqual("READY");
      expect(created.description).toEqual("burst capacity");
      expect(created.specificReservationRequired).toEqual(true);
      expect(created.specificReservation?.count).toEqual("1");

      const fetched = yield* compute.getReservations({
        project: created.project,
        zone: created.zone,
        reservation: created.reservationName,
      });
      expect(fetched.name).toEqual(created.reservationName);
      expect(fetched.status).toEqual("READY");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("burst capacity");
      expect(fetched.specificReservation?.count).toEqual("1");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Reservation("Burst", {
            reservationName: created.reservationName,
            zone,
            description: "burst capacity",
            specificReservation: {
              count: 2,
              instanceProperties: { machineType: "n1-standard-1" },
            },
            specificReservationRequired: true,
          });
        }),
      );

      expect(updated.reservationName).toEqual(created.reservationName);
      expect(updated.specificReservation?.count).toEqual("2");

      const fetchedUpdated = yield* compute.getReservations({
        project: updated.project,
        zone: updated.zone,
        reservation: updated.reservationName,
      });
      expect(fetchedUpdated.specificReservation?.count).toEqual("2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.project,
        created.zone,
        created.reservationName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 300_000 },
);

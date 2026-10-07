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

// Future reservations are gated on account history; the testing project gets
// `FutureReservationsNotEligible` (HTTP 412: "Based on your service usage
// history, you are not eligible for using the Future Reservations feature").
// Set GCP_TEST_FUTURE_RESERVATION=1 on an eligible project.
const runLifecycle =
  !!process.env.GCP_TEST_FUTURE_RESERVATION && !process.env.FAST;

const zone = "us-central1-a";

const draftProps = {
  zone,
  planningStatus: "DRAFT" as const,
  timeWindow: {
    startTime: "2030-06-01T00:00:00Z",
    endTime: "2030-06-08T00:00:00Z",
  },
  specificSkuProperties: {
    totalCount: "1",
    instanceProperties: { machineType: "n2-standard-2" },
  },
};

const waitUntilGone = (
  project: string,
  zoneName: string,
  futureReservation: string,
) =>
  compute
    .getFutureReservations({ project, zone: zoneName, futureReservation })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(runLifecycle)(
  "insertFutureReservations without eligibility fails with FutureReservationsNotEligible",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        compute.insertFutureReservations({
          project,
          zone,
          body: {
            name: "alchemy-fr-probe",
            description: "alchemy entitlement probe",
            autoDeleteAutoCreatedReservations: false,
            ...draftProps,
            zone: undefined,
          },
        }),
      );
      expect(error._tag).toEqual("FutureReservationsNotEligible");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a future reservation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.FutureReservation("Burst", {
            ...draftProps,
            description: "draft capacity",
          });
        }),
      );

      expect(created.futureReservationName).toEqual(expect.any(String));
      expect(created.zone).toEqual(zone);
      expect(created.description).toEqual("draft capacity");
      expect(created.planningStatus).toEqual("DRAFT");

      const fetched = yield* compute.getFutureReservations({
        project: created.project,
        zone,
        futureReservation: created.futureReservationName,
      });
      expect(fetched.name).toEqual(created.futureReservationName);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.FutureReservation("Burst", {
            ...draftProps,
            futureReservationName: created.futureReservationName,
            description: "updated draft",
          });
        }),
      );
      expect(updated.description).toEqual("updated draft");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.project,
        zone,
        created.futureReservationName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { Region } from "@distilled.cloud/aws/Region";
import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import FleetWiseBindingsFunctionLive, {
  FleetWiseBindingsFunction,
} from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// AWS IoT FleetWise is allowlist-gated — accounts without service access
// observe AccessDeniedException on every operation. The live Lambda E2E
// needs real FleetWise resources, so it is gated behind
// AWS_TEST_IOTFLEETWISE=1 for allowlisted accounts.
const RUN_LIVE = !!process.env.AWS_TEST_IOTFLEETWISE;

// FleetWise is offered in us-east-1/eu-central-1 only — pin every
// out-of-band distilled call to the service's home region.
const inHomeRegion = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.provideService(Region, Effect.succeed("us-east-1")));

// Ungated typed-error probes: prove the distilled error unions the bindings
// depend on decode on every account, allowlisted or not, at near-zero cost.
test.provider(
  "getVehicleStatus on a nonexistent vehicle fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        iotfleetwise
          .getVehicleStatus({
            vehicleName: "alchemy-nonexistent-vehicle-probe",
          })
          .pipe(inHomeRegion),
      );
      expect(["ResourceNotFoundException", "AccessDeniedException"]).toContain(
        error._tag,
      );
    }),
);

test.provider(
  "listVehiclesInFleet on a nonexistent fleet fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        iotfleetwise
          .listVehiclesInFleet({ fleetId: "alchemy-nonexistent-fleet-probe" })
          .pipe(inHomeRegion),
      );
      expect(["ResourceNotFoundException", "AccessDeniedException"]).toContain(
        error._tag,
      );
    }),
);

const sharedStack = Core.scratchStack(testOptions, "FleetWiseBindings");

let baseUrl: string;

const get = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));
const post = (path: string) =>
  HttpClient.post(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

describe("IoTFleetWise Bindings (E2E)", () => {
  beforeAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* Effect.logInfo("FleetWise E2E setup: destroying previous run");
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "FleetWise E2E setup: deploying resources + Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* FleetWiseBindingsFunction;
        }).pipe(Effect.provide(FleetWiseBindingsFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(60),
          ]),
        }),
      );
    }),
    { timeout: 600_000 },
  );
  afterAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* sharedStack.destroy();
    }),
    { timeout: 600_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "all 13 capabilities initialize in the runtime",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/bindings")) as any;
        expect(response.bound).toHaveLength(13);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "GetVehicleStatus reads the bound vehicle's campaign deployments",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/vehicle-status")) as any;
        expect(typeof response.campaigns).toBe("number");
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "Associate/Disassociate + ListVehiclesInFleet + ListFleetsForVehicle round-trip",
    () =>
      Effect.gen(function* () {
        const associated = (yield* post("/fleet/associate")) as any;
        expect(associated.count).toBeGreaterThanOrEqual(1);
        const fleets = (yield* get("/vehicle-fleets")) as any;
        expect(fleets.count).toBeGreaterThanOrEqual(1);
        const disassociated = (yield* post("/fleet/disassociate")) as any;
        expect(disassociated.ok).toBe(true);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "signal-definition reads cover catalog, model, and decoder",
    () =>
      Effect.gen(function* () {
        const catalogNodes = (yield* get("/catalog-nodes")) as any;
        expect(catalogNodes.count).toBe(3);
        const modelNodes = (yield* get("/model-nodes")) as any;
        expect(modelNodes.count).toBeGreaterThanOrEqual(2);
        const interfaces = (yield* get("/decoder-interfaces")) as any;
        expect(interfaces.count).toBe(1);
        const signals = (yield* get("/decoder-signals")) as any;
        expect(signals.count).toBe(1);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "ListVehicles filters by the bound model manifest",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/vehicles")) as any;
        expect(response.count).toBeGreaterThanOrEqual(1);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "UpdateCampaign suspends and resumes the running campaign",
    () =>
      Effect.gen(function* () {
        const response = (yield* post("/campaign/suspend-resume")) as any;
        expect(response.ok).toBe(true);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "BatchUpdateVehicle succeeds and BatchCreateVehicle surfaces per-item errors",
    () =>
      Effect.gen(function* () {
        const response = (yield* post("/vehicles/batch")) as any;
        expect(response.updated).toBe(1);
        expect(response.updateErrors).toBe(0);
        expect(response.createErrors).toBe(1);
      }),
  );
});

import * as AWS from "@/AWS";
import {
  Campaign,
  DecoderManifest,
  Fleet,
  ModelManifest,
  SignalCatalog,
  StateTemplate,
  Vehicle,
} from "@/AWS/IoTFleetWise";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import { Region } from "@distilled.cloud/aws/Region";
import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic bucket name (constant per test suite — never Date.now())
// so the FleetWise bucket policy can reference the ARN as a literal.
const TELEMETRY_BUCKET = "alchemy-test-iotfleetwise-telemetry";

// AWS IoT FleetWise is offered in us-east-1/eu-central-1 only — pin every
// out-of-band distilled call to the service's home region (the providers
// pin themselves the same way).
const inHomeRegion = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.provideService(Region, Effect.succeed("us-east-1")));

// Ungated typed-error probe: prove the distilled error union carries the
// typed tags the providers' read/delete paths depend on. AWS IoT FleetWise
// is allowlist-gated — accounts without service access observe
// AccessDeniedException (with an empty message) on every operation, while
// allowlisted accounts observe ResourceNotFoundException for a bogus name.
// Both are typed tags in the operation's error union; the probe proves the
// decode path for whichever gate this account is behind.
test.provider(
  "getSignalCatalog on a nonexistent catalog fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        iotfleetwise
          .getSignalCatalog({ name: "alchemy-nonexistent-catalog-probe" })
          .pipe(inHomeRegion),
      );
      expect(["ResourceNotFoundException", "AccessDeniedException"]).toContain(
        error._tag,
      );
    }),
);

// Same ungated probe for the state-template API — proves the typed tags the
// StateTemplate provider's read path depends on decode on every account.
test.provider(
  "getStateTemplate on a nonexistent template fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        iotfleetwise
          .getStateTemplate({
            identifier: "alchemy-nonexistent-state-template-probe",
          })
          .pipe(inHomeRegion),
      );
      expect(["ResourceNotFoundException", "AccessDeniedException"]).toContain(
        error._tag,
      );
    }),
);

// Typed wait-until-gone for the gated lifecycle teardown.
const assertCatalogGone = (name: string) =>
  Effect.gen(function* () {
    const found = yield* iotfleetwise.getSignalCatalog({ name }).pipe(
      inHomeRegion,
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
    if (found !== undefined) {
      return yield* Effect.fail(
        new Error(`signal catalog '${name}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );

// Full lifecycle across all six resources. AWS IoT FleetWise requires the
// account to be allowlisted for the service (and registered via
// RegisterAccount for legacy Timestream destinations) — the standing test
// account is not, so the live run is gated behind AWS_TEST_IOTFLEETWISE=1.
// All six resources are free and provision in seconds once entitled.
test.provider.skipIf(!process.env.AWS_TEST_IOTFLEETWISE)(
  "signal catalog -> model -> decoder -> fleet -> vehicle -> campaign lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const catalog = yield* SignalCatalog("Signals", {
            description: "alchemy fleetwise test signals",
            nodes: [
              { branch: { fullyQualifiedName: "Vehicle" } },
              {
                sensor: {
                  fullyQualifiedName: "Vehicle.Speed",
                  dataType: "DOUBLE",
                  unit: "km/h",
                },
              },
              {
                attribute: {
                  fullyQualifiedName: "Vehicle.VIN",
                  dataType: "STRING",
                },
              },
            ],
            tags: { fixture: "iotfleetwise" },
          });

          const model = yield* ModelManifest("SedanModel", {
            signalCatalogArn: catalog.signalCatalogArn,
            nodes: ["Vehicle.Speed", "Vehicle.VIN"],
            description: "alchemy fleetwise test model",
            status: "ACTIVE",
          });

          const decoder = yield* DecoderManifest("SedanDecoder", {
            modelManifestArn: model.modelManifestArn,
            description: "alchemy fleetwise test decoder",
            networkInterfaces: [
              {
                interfaceId: "obd0",
                type: "OBD_INTERFACE",
                obdInterface: { name: "obd", requestMessageId: 2015 },
              },
            ],
            signalDecoders: [
              {
                fullyQualifiedName: "Vehicle.Speed",
                type: "OBD_SIGNAL",
                interfaceId: "obd0",
                obdSignal: {
                  pidResponseLength: 1,
                  serviceMode: 1,
                  pid: 13,
                  scaling: 1,
                  offset: 0,
                  startByte: 0,
                  byteLength: 1,
                },
              },
            ],
            status: "ACTIVE",
          });

          const fleet = yield* Fleet("TestFleet", {
            signalCatalogArn: catalog.signalCatalogArn,
            description: "alchemy fleetwise test fleet",
          });

          const vehicle = yield* Vehicle("TestVehicle", {
            modelManifestArn: model.modelManifestArn,
            decoderManifestArn: decoder.decoderManifestArn,
            attributes: { "Vehicle.VIN": "1HGBH41JXMN109186" },
          });

          const stateTemplate = yield* StateTemplate("SpeedState", {
            signalCatalogArn: catalog.signalCatalogArn,
            stateTemplateProperties: ["Vehicle.Speed"],
            description: "alchemy fleetwise test state template",
          });

          // Campaign data lands in S3; FleetWise writes require a bucket
          // policy trusting the service principal. Deterministic name so
          // the policy can reference the bucket ARN as a literal.
          const bucket = yield* Bucket("TelemetryBucket", {
            bucketName: TELEMETRY_BUCKET,
            forceDestroy: true,
            policy: [
              {
                Effect: "Allow",
                Principal: { Service: "iotfleetwise.amazonaws.com" },
                Action: ["s3:GetBucketLocation", "s3:PutObject"],
                Resource: [
                  `arn:aws:s3:::${TELEMETRY_BUCKET}`,
                  `arn:aws:s3:::${TELEMETRY_BUCKET}/*`,
                ],
              },
            ],
          });

          const campaign = yield* Campaign("SpeedTelemetry", {
            signalCatalogArn: catalog.signalCatalogArn,
            targetArn: fleet.fleetArn,
            collectionScheme: {
              timeBasedCollectionScheme: { period: "10 seconds" },
            },
            signalsToCollect: [{ name: "Vehicle.Speed" }],
            dataDestinationConfigs: [
              { s3Config: { bucketArn: bucket.bucketArn } },
            ],
          });

          return {
            catalog,
            model,
            decoder,
            fleet,
            vehicle,
            stateTemplate,
            campaign,
          };
        }),
      );

      expect(deployed.catalog.signalCatalogArn).toContain(":signal-catalog/");
      expect(deployed.stateTemplate.stateTemplateArn).toContain(
        ":state-template/",
      );
      expect(deployed.stateTemplate.stateTemplateProperties).toEqual([
        "Vehicle.Speed",
      ]);
      expect(deployed.model.status).toBe("ACTIVE");
      expect(deployed.decoder.status).toBe("ACTIVE");
      expect(deployed.fleet.fleetArn).toContain(":fleet/");
      expect(deployed.vehicle.vehicleArn).toContain(":vehicle/");
      expect(deployed.campaign.status).toBe("WAITING_FOR_APPROVAL");

      // Out-of-band verification via distilled.
      const observedModel = yield* iotfleetwise
        .getModelManifest({ name: deployed.model.modelManifestName })
        .pipe(inHomeRegion);
      expect(observedModel.status).toBe("ACTIVE");
      const observedVehicle = yield* iotfleetwise
        .getVehicle({ vehicleName: deployed.vehicle.vehicleName })
        .pipe(inHomeRegion);
      expect(observedVehicle.attributes?.["Vehicle.VIN"]).toBe(
        "1HGBH41JXMN109186",
      );

      yield* stack.destroy();
      yield* assertCatalogGone(deployed.catalog.signalCatalogName);
    }),
  { timeout: 600_000 },
);

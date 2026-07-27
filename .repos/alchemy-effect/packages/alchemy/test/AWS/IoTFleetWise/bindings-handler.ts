import * as IoTFleetWise from "@/AWS/IoTFleetWise";
import * as Lambda from "@/AWS/Lambda";
import { Bucket } from "@/AWS/S3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

// Deterministic bucket name (constant per test suite — never Date.now())
// so the FleetWise bucket policy can reference the ARN as a literal.
const TELEMETRY_BUCKET = "alchemy-test-iotfleetwise-bindings";

export class FleetWiseBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "FleetWiseBindingsFunction",
) {}

export default FleetWiseBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const catalog = yield* IoTFleetWise.SignalCatalog("BindingsSignals", {
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
    });

    const model = yield* IoTFleetWise.ModelManifest("BindingsModel", {
      signalCatalogArn: catalog.signalCatalogArn,
      nodes: ["Vehicle.Speed", "Vehicle.VIN"],
      status: "ACTIVE",
    });

    const decoder = yield* IoTFleetWise.DecoderManifest("BindingsDecoder", {
      modelManifestArn: model.modelManifestArn,
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

    const fleet = yield* IoTFleetWise.Fleet("BindingsFleet", {
      signalCatalogArn: catalog.signalCatalogArn,
    });

    const vehicle = yield* IoTFleetWise.Vehicle("BindingsVehicle", {
      modelManifestArn: model.modelManifestArn,
      decoderManifestArn: decoder.decoderManifestArn,
      attributes: { "Vehicle.VIN": "1HGBH41JXMN109186" },
    });

    const bucket = yield* Bucket("BindingsTelemetryBucket", {
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

    // Auto-approved so the campaign is RUNNING and the SUSPEND/RESUME
    // control route exercises real state transitions.
    const campaign = yield* IoTFleetWise.Campaign("BindingsCampaign", {
      signalCatalogArn: catalog.signalCatalogArn,
      targetArn: fleet.fleetArn,
      collectionScheme: {
        timeBasedCollectionScheme: { period: "10 seconds" },
      },
      signalsToCollect: [{ name: "Vehicle.Speed" }],
      dataDestinationConfigs: [{ s3Config: { bucketArn: bucket.bucketArn } }],
      autoApprove: true,
    });

    const VehicleName = yield* vehicle.vehicleName;
    const ModelManifestArn = yield* model.modelManifestArn;

    const getVehicleStatus = yield* IoTFleetWise.GetVehicleStatus(vehicle);
    const listFleetsForVehicle =
      yield* IoTFleetWise.ListFleetsForVehicle(vehicle);
    const listVehiclesInFleet = yield* IoTFleetWise.ListVehiclesInFleet(fleet);
    const associateVehicleFleet =
      yield* IoTFleetWise.AssociateVehicleFleet(fleet);
    const disassociateVehicleFleet =
      yield* IoTFleetWise.DisassociateVehicleFleet(fleet);
    const updateCampaign = yield* IoTFleetWise.UpdateCampaign(campaign);
    const listSignalCatalogNodes =
      yield* IoTFleetWise.ListSignalCatalogNodes(catalog);
    const listModelManifestNodes =
      yield* IoTFleetWise.ListModelManifestNodes(model);
    const listDecoderManifestNetworkInterfaces =
      yield* IoTFleetWise.ListDecoderManifestNetworkInterfaces(decoder);
    const listDecoderManifestSignals =
      yield* IoTFleetWise.ListDecoderManifestSignals(decoder);
    const batchCreateVehicle = yield* IoTFleetWise.BatchCreateVehicle();
    const batchUpdateVehicle = yield* IoTFleetWise.BatchUpdateVehicle();
    const listVehicles = yield* IoTFleetWise.ListVehicles();

    const bound = {
      getVehicleStatus,
      listFleetsForVehicle,
      listVehiclesInFleet,
      associateVehicleFleet,
      disassociateVehicleFleet,
      updateCampaign,
      listSignalCatalogNodes,
      listModelManifestNodes,
      listDecoderManifestNetworkInterfaces,
      listDecoderManifestSignals,
      batchCreateVehicle,
      batchUpdateVehicle,
      listVehicles,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/vehicle-status") {
          const response = yield* getVehicleStatus();
          return yield* HttpServerResponse.json({
            campaigns: (response.campaigns ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/vehicle-fleets") {
          const response = yield* listFleetsForVehicle();
          return yield* HttpServerResponse.json({
            count: (response.fleets ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/fleet-vehicles") {
          const response = yield* listVehiclesInFleet();
          return yield* HttpServerResponse.json({
            count: (response.vehicles ?? []).length,
          });
        }

        if (request.method === "POST" && pathname === "/fleet/associate") {
          const vehicleName = yield* VehicleName;
          yield* associateVehicleFleet({ vehicleName });
          const inFleet = yield* listVehiclesInFleet();
          return yield* HttpServerResponse.json({
            count: (inFleet.vehicles ?? []).length,
          });
        }

        if (request.method === "POST" && pathname === "/fleet/disassociate") {
          const vehicleName = yield* VehicleName;
          yield* disassociateVehicleFleet({ vehicleName });
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/catalog-nodes") {
          const response = yield* listSignalCatalogNodes();
          return yield* HttpServerResponse.json({
            count: (response.nodes ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/model-nodes") {
          const response = yield* listModelManifestNodes();
          return yield* HttpServerResponse.json({
            count: (response.nodes ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/decoder-interfaces") {
          const response = yield* listDecoderManifestNetworkInterfaces();
          return yield* HttpServerResponse.json({
            count: (response.networkInterfaces ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/decoder-signals") {
          const response = yield* listDecoderManifestSignals();
          return yield* HttpServerResponse.json({
            count: (response.signalDecoders ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/vehicles") {
          const response = yield* listVehicles({
            modelManifestArn: yield* ModelManifestArn,
          });
          return yield* HttpServerResponse.json({
            count: (response.vehicleSummaries ?? []).length,
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/campaign/suspend-resume"
        ) {
          yield* updateCampaign({ action: "SUSPEND" });
          yield* updateCampaign({ action: "RESUME" });
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/vehicles/batch") {
          const vehicleName = yield* VehicleName;
          // Per-item success: merge an attribute onto the fixture vehicle.
          const updated = yield* batchUpdateVehicle({
            vehicles: [
              {
                vehicleName,
                attributes: { "Vehicle.VIN": "1HGBH41JXMN109186" },
                attributeUpdateMode: "Merge",
              },
            ],
          });
          // Per-item failure (bogus manifest ARN) — returned in `errors`,
          // never creating an orphan vehicle. Proves the grant end-to-end.
          const created = yield* batchCreateVehicle({
            vehicles: [
              {
                vehicleName: "alchemy-bindings-bogus-vehicle",
                modelManifestArn:
                  "arn:aws:iotfleetwise:us-east-1:000000000000:model-manifest/nonexistent",
                decoderManifestArn:
                  "arn:aws:iotfleetwise:us-east-1:000000000000:decoder-manifest/nonexistent",
              },
            ],
          });
          return yield* HttpServerResponse.json({
            updated: (updated.vehicles ?? []).length,
            updateErrors: (updated.errors ?? []).length,
            createErrors: (created.errors ?? []).length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        IoTFleetWise.GetVehicleStatusHttp,
        IoTFleetWise.ListFleetsForVehicleHttp,
        IoTFleetWise.ListVehiclesInFleetHttp,
        IoTFleetWise.AssociateVehicleFleetHttp,
        IoTFleetWise.DisassociateVehicleFleetHttp,
        IoTFleetWise.UpdateCampaignHttp,
        IoTFleetWise.ListSignalCatalogNodesHttp,
        IoTFleetWise.ListModelManifestNodesHttp,
        IoTFleetWise.ListDecoderManifestNetworkInterfacesHttp,
        IoTFleetWise.ListDecoderManifestSignalsHttp,
        IoTFleetWise.BatchCreateVehicleHttp,
        IoTFleetWise.BatchUpdateVehicleHttp,
        IoTFleetWise.ListVehiclesHttp,
      ),
    ),
  ),
);

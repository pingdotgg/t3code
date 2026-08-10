import * as IoTManagedIntegrations from "@/AWS/IoTManagedIntegrations";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

// Same synthetic Zigbee install-code QR payload the ManagedThing lifecycle
// test uses — CreateManagedThing validates the payload shape, not that the
// device exists. Checked in as a constant (never generated at test time).
const ZIGBEE_QR_PAYLOAD = "Z:24FD5B0000015C63$I:83FED3407A939738";

export class IoTMITestFunction extends Lambda.Function<Lambda.Function>()(
  "IoTMITestFunction",
) {}

/**
 * Every route answers `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error. The gated test asserts concrete fields
 * where the API can succeed against an unprovisioned device, and asserts the
 * tag is typed-and-not-AccessDenied elsewhere — which proves the binding
 * wiring, the identifier injection, and the IAM grants.
 */
const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string } => a),
    Effect.catch((e) => Effect.succeed({ errorTag: e._tag })),
  );

/**
 * Bindings fixture: a credential locker + an (unprovisioned) Zigbee DEVICE
 * managed thing, and a Lambda bound to every IoT Managed Integrations
 * runtime binding. Deployed only by the gated Bindings test (the service
 * exists in a handful of regions).
 */
export default IoTMITestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const locker = yield* IoTManagedIntegrations.CredentialLocker("Locker", {});
    const thing = yield* IoTManagedIntegrations.ManagedThing("Device", {
      role: "DEVICE",
      authenticationMaterial: Redacted.make(ZIGBEE_QR_PAYLOAD),
      authenticationMaterialType: "ZIGBEE_QR_BAR_CODE",
      credentialLockerId: locker.credentialLockerId,
      serialNumber: "SN-ALCHEMY-BINDINGS-0001",
      tags: { fixture: "iot-mi-bindings" },
    });

    const sendCommand =
      yield* IoTManagedIntegrations.SendManagedThingCommand(thing);
    const getState = yield* IoTManagedIntegrations.GetManagedThingState(thing);
    const getCapabilities =
      yield* IoTManagedIntegrations.GetManagedThingCapabilities(thing);
    const getCertificate =
      yield* IoTManagedIntegrations.GetManagedThingCertificate(thing);
    const getConnectivity =
      yield* IoTManagedIntegrations.GetManagedThingConnectivityData(thing);
    const getMetaData =
      yield* IoTManagedIntegrations.GetManagedThingMetaData(thing);
    const listThingSchemas =
      yield* IoTManagedIntegrations.ListManagedThingSchemas(thing);
    const startDiscovery = yield* IoTManagedIntegrations.StartDeviceDiscovery();
    const getDiscovery = yield* IoTManagedIntegrations.GetDeviceDiscovery();
    const listDiscoveries =
      yield* IoTManagedIntegrations.ListDeviceDiscoveries();
    const listDiscovered =
      yield* IoTManagedIntegrations.ListDiscoveredDevices();
    const getSchemaVersion = yield* IoTManagedIntegrations.GetSchemaVersion();
    const listSchemaVersions =
      yield* IoTManagedIntegrations.ListSchemaVersions();
    const getCustomEndpoint = yield* IoTManagedIntegrations.GetCustomEndpoint();
    const sendConnectorEvent =
      yield* IoTManagedIntegrations.SendConnectorEvent();

    const bound = {
      sendCommand,
      getState,
      getCapabilities,
      getCertificate,
      getConnectivity,
      getMetaData,
      listThingSchemas,
      startDiscovery,
      getDiscovery,
      listDiscoveries,
      listDiscovered,
      getSchemaVersion,
      listSchemaVersions,
      getCustomEndpoint,
      sendConnectorEvent,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        // -- account-level ops (Resource "*") ------------------------------
        if (pathname === "/schema-versions") {
          const result = yield* errorTagged(
            listSchemaVersions({ Type: "capability", MaxResults: 3 }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  count: (result.Items ?? []).length,
                  first: result.Items?.[0],
                },
          );
        }
        if (pathname === "/schema-version") {
          const id = url.searchParams.get("id") ?? "";
          const result = yield* errorTagged(
            getSchemaVersion({ Type: "capability", SchemaVersionedId: id }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { schemaId: result.SchemaId },
          );
        }
        if (pathname === "/custom-endpoint") {
          const result = yield* errorTagged(getCustomEndpoint());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { endpointAddress: result.EndpointAddress },
          );
        }
        if (pathname === "/discovery") {
          // No live controller in the fixture — expect a TYPED rejection
          // (never AccessDenied), which still proves wiring + IAM.
          const result = yield* errorTagged(
            startDiscovery({
              DiscoveryType: "ZWAVE",
              ControllerIdentifier: "alchemy-nonexistent-controller",
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { id: result.Id },
          );
        }
        if (pathname === "/discoveries") {
          const result = yield* errorTagged(
            listDiscoveries({ StatusFilter: "RUNNING" }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: (result.Items ?? []).length },
          );
        }
        if (pathname === "/get-discovery") {
          const result = yield* errorTagged(
            getDiscovery({ Identifier: "alchemynonexistentdiscovery" }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { status: result.Status },
          );
        }
        if (pathname === "/discovered") {
          const result = yield* errorTagged(
            listDiscovered({ Identifier: "alchemynonexistentdiscovery" }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: (result.Items ?? []).length },
          );
        }
        if (pathname === "/connector-event") {
          const result = yield* errorTagged(
            sendConnectorEvent({
              ConnectorId: "alchemynonexistentconnector",
              Operation: "DEVICE_EVENT",
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { connectorId: result.ConnectorId },
          );
        }

        // -- managed-thing-scoped ops (grant on the thing ARN) --------------
        if (pathname === "/metadata") {
          const result = yield* errorTagged(getMetaData());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { managedThingId: result.ManagedThingId },
          );
        }
        if (pathname === "/capabilities") {
          const result = yield* errorTagged(getCapabilities());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { managedThingId: result.ManagedThingId },
          );
        }
        if (pathname === "/certificate") {
          const result = yield* errorTagged(getCertificate());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { hasPem: result.CertificatePem !== undefined },
          );
        }
        if (pathname === "/connectivity") {
          const result = yield* errorTagged(getConnectivity());
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { connected: result.Connected },
          );
        }
        if (pathname === "/state") {
          const result = yield* errorTagged(getState());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { endpoints: result.Endpoints.length },
          );
        }
        if (pathname === "/thing-schemas") {
          const result = yield* errorTagged(listThingSchemas());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: (result.Items ?? []).length },
          );
        }
        if (pathname === "/command") {
          // Unprovisioned device — expect a TYPED rejection (never
          // AccessDenied), which still proves wiring + IAM.
          const result = yield* errorTagged(
            sendCommand({
              Endpoints: [
                {
                  endpointId: "1",
                  capabilities: [
                    {
                      id: "aws.OnOff",
                      name: "On/Off",
                      version: "1",
                      actions: [{ name: "activate" }],
                    },
                  ],
                },
              ],
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { traceId: result.TraceId },
          );
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        IoTManagedIntegrations.SendManagedThingCommandHttp,
        IoTManagedIntegrations.GetManagedThingStateHttp,
        IoTManagedIntegrations.GetManagedThingCapabilitiesHttp,
        IoTManagedIntegrations.GetManagedThingCertificateHttp,
        IoTManagedIntegrations.GetManagedThingConnectivityDataHttp,
        IoTManagedIntegrations.GetManagedThingMetaDataHttp,
        IoTManagedIntegrations.ListManagedThingSchemasHttp,
        IoTManagedIntegrations.StartDeviceDiscoveryHttp,
        IoTManagedIntegrations.GetDeviceDiscoveryHttp,
        IoTManagedIntegrations.ListDeviceDiscoveriesHttp,
        IoTManagedIntegrations.ListDiscoveredDevicesHttp,
        IoTManagedIntegrations.GetSchemaVersionHttp,
        IoTManagedIntegrations.ListSchemaVersionsHttp,
        IoTManagedIntegrations.GetCustomEndpointHttp,
        IoTManagedIntegrations.SendConnectorEventHttp,
      ),
    ),
  ),
);

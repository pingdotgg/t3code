import * as AWS from "@/AWS";
import * as IoTWireless from "@/AWS/IoTWireless";
import * as Lambda from "@/AWS/Lambda";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Deterministic fabricated radio identities — an ABP device pre-provisions
// its session keys, so the downlink queue works without any radio hardware
// ever joining. Distinct from the identities used by IoTWireless.test.ts.
const DEV_EUI = "1a2b3c4d5e6f7091";
const DEV_ADDR = "01020304";
const NWK_S_KEY = Redacted.make("000102030405060708090a0b0c0d0e0f");
const APP_S_KEY = Redacted.make("0f0e0d0c0b0a09080706050403020100");
const GATEWAY_EUI = "aa555a0000000201";

// base64("Hello, World!")
const PAYLOAD = "SGVsbG8sIFdvcmxkIQ==";

export class IoTWirelessTestFunction extends Lambda.Function<Lambda.Function>()(
  "IoTWirelessTestFunction",
) {}

// Result queue observed by the test: the DestinationEventSource handler
// forwards every uplink routed through the destination into this queue so
// delivery can be verified out-of-band.
export class ResultQueue extends Context.Service<
  ResultQueue,
  { result: AWS.SQS.Queue }
>()("IoTWirelessResultQueue") {}

export const ResultQueueLive = Layer.effect(
  ResultQueue,
  Effect.gen(function* () {
    const result = yield* AWS.SQS.Queue("IoTWirelessUplinkResultQueue");
    return { result };
  }),
);

export default IoTWirelessTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The IAM role IoT Wireless assumes to deliver uplinks to the rule.
    const role = yield* AWS.IAM.Role("IotWirelessBindingsDelivery", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "iotwireless.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        deliver: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["iot:DescribeEndpoint", "iot:Publish"],
              Resource: ["*"],
            },
          ],
        },
      },
    });

    const destination = yield* IoTWireless.Destination("BindingsUplinks", {
      expressionType: "RuleName",
      expression: "alchemy_iot_wireless_bindings_rule",
      roleArn: role.roleArn,
      tags: { fixture: "iot-wireless-bindings" },
    });
    const serviceProfile = yield* IoTWireless.ServiceProfile("BindingsFleet", {
      loRaWAN: { AddGwMetadata: true },
      tags: { fixture: "iot-wireless-bindings" },
    });
    const deviceProfile = yield* IoTWireless.DeviceProfile("BindingsModel", {
      loRaWAN: {
        MacVersion: "1.0.3",
        RegParamsRevision: "RP002-1.0.1",
        RfRegion: "US915",
        MaxEirp: 10,
        SupportsJoin: false,
      },
      tags: { fixture: "iot-wireless-bindings" },
    });
    const device = yield* IoTWireless.WirelessDevice("BindingsSensor", {
      type: "LoRaWAN",
      destinationName: destination.destinationName,
      description: "alchemy iot-wireless bindings fixture device",
      positioning: "Enabled",
      loRaWAN: {
        DevEui: DEV_EUI,
        DeviceProfileId: deviceProfile.deviceProfileId,
        ServiceProfileId: serviceProfile.serviceProfileId,
        AbpV1_0_x: {
          DevAddr: DEV_ADDR,
          SessionKeys: { NwkSKey: NWK_S_KEY, AppSKey: APP_S_KEY },
        },
      },
      tags: { fixture: "iot-wireless-bindings" },
    });
    const gateway = yield* IoTWireless.WirelessGateway("BindingsGateway", {
      description: "alchemy iot-wireless bindings fixture gateway",
      loRaWAN: { GatewayEui: GATEWAY_EUI, RfRegion: "US915" },
      tags: { fixture: "iot-wireless-bindings" },
    });

    // device-scoped
    const sendData = yield* IoTWireless.SendDataToWirelessDevice(device);
    const listQueued = yield* IoTWireless.ListQueuedMessages(device);
    const deleteQueued = yield* IoTWireless.DeleteQueuedMessages(device);
    const getDeviceStats =
      yield* IoTWireless.GetWirelessDeviceStatistics(device);
    const testDevice = yield* IoTWireless.TestWirelessDevice(device);
    const getPosition = yield* IoTWireless.GetResourcePosition(device);
    const updatePosition = yield* IoTWireless.UpdateResourcePosition(device);
    // gateway-scoped
    const getGatewayStats =
      yield* IoTWireless.GetWirelessGatewayStatistics(gateway);
    // account-level
    const getEndpoint = yield* IoTWireless.GetServiceEndpoint();
    const estimatePosition = yield* IoTWireless.GetPositionEstimate();

    // Event source: every uplink routed through the destination (including
    // TestWirelessDevice's simulated "Hello" uplink) invokes this function;
    // forward each envelope into the result queue for the test to observe.
    const { result } = yield* ResultQueue;
    const sink = yield* AWS.SQS.QueueSink(result);
    yield* IoTWireless.consumeUplinks(destination, (uplinks) =>
      uplinks.pipe(
        Stream.map((uplink) => ({ MessageBody: JSON.stringify(uplink) })),
        Stream.run(sink),
        Effect.orDie,
      ),
    );
    const resultQueueUrl = yield* result.queueUrl;

    const decodeGeoJson = (
      payload: Stream.Stream<Uint8Array, Error> | undefined,
    ) =>
      payload === undefined
        ? Effect.succeed(undefined)
        : Stream.mkString(Stream.decodeText(payload));

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({
            ok: true,
            resultQueueUrl: yield* resultQueueUrl,
          });
        }

        if (request.method === "POST" && pathname === "/send") {
          const result = yield* sendData({
            PayloadData: PAYLOAD,
            TransmitMode: 1,
            WirelessMetadata: { LoRaWAN: { FPort: 1 } },
          });
          return yield* HttpServerResponse.json({
            messageId: result.MessageId ?? null,
          });
        }

        if (request.method === "POST" && pathname === "/queued") {
          const result = yield* listQueued();
          const messages = result.DownlinkQueueMessagesList ?? [];
          return yield* HttpServerResponse.json({
            count: messages.length,
            messageIds: messages.map((m) => m.MessageId ?? null),
          });
        }

        if (request.method === "POST" && pathname === "/purge") {
          // "*" purges every queued downlink message.
          yield* deleteQueued({ MessageId: "*" });
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/device-stats") {
          const stats = yield* getDeviceStats();
          return yield* HttpServerResponse.json({
            wirelessDeviceId: stats.WirelessDeviceId ?? null,
            lastUplinkReceivedAt: stats.LastUplinkReceivedAt ?? null,
          });
        }

        if (request.method === "POST" && pathname === "/test-device") {
          const result = yield* testDevice();
          return yield* HttpServerResponse.json({
            result: result.Result ?? null,
          });
        }

        if (request.method === "POST" && pathname === "/gateway-stats") {
          const stats = yield* getGatewayStats();
          return yield* HttpServerResponse.json({
            wirelessGatewayId: stats.WirelessGatewayId ?? null,
            connectionStatus: stats.ConnectionStatus ?? null,
          });
        }

        if (request.method === "POST" && pathname === "/service-endpoint") {
          const endpoint = yield* getEndpoint({ ServiceType: "LNS" });
          return yield* HttpServerResponse.json({
            serviceType: endpoint.ServiceType ?? null,
            serviceEndpoint: endpoint.ServiceEndpoint ?? null,
          });
        }

        if (request.method === "POST" && pathname === "/update-position") {
          // Coordinates are [longitude, latitude, altitude].
          yield* updatePosition({
            GeoJsonPayload: JSON.stringify({
              type: "Point",
              coordinates: [-122.33, 47.61, 10],
            }),
          });
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/position") {
          const result = yield* getPosition();
          const geoJson = yield* decodeGeoJson(result.GeoJsonPayload);
          return yield* HttpServerResponse.json({ geoJson: geoJson ?? null });
        }

        if (request.method === "POST" && pathname === "/position-estimate") {
          // Fabricated WiFi scans exercise the solver path end-to-end; the
          // solver may not resolve unknown MACs, so surface the typed tag
          // instead of failing the route.
          const result = yield* Effect.result(
            estimatePosition({
              WiFiAccessPoints: [
                { MacAddress: "A0:EC:F9:1E:32:C1", Rss: -66 },
                { MacAddress: "A0:EC:F9:15:72:5E", Rss: -72 },
              ],
            }),
          );
          if (Result.isSuccess(result)) {
            const geoJson = yield* decodeGeoJson(result.success.GeoJsonPayload);
            return yield* HttpServerResponse.json({
              ok: true,
              geoJson: geoJson ?? null,
            });
          }
          return yield* HttpServerResponse.json({
            ok: false,
            tag: result.failure._tag,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        // Surface typed API errors AND defects as diagnosable 500s (the
        // test's post helper retries 5xx through IAM propagation).
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(
              `IoTWireless fixture error: ${String(Cause.squash(cause))}`,
              { status: 500 },
            ),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(
          IoTWireless.SendDataToWirelessDeviceHttp,
          IoTWireless.ListQueuedMessagesHttp,
          IoTWireless.DeleteQueuedMessagesHttp,
          IoTWireless.GetWirelessDeviceStatisticsHttp,
          IoTWireless.TestWirelessDeviceHttp,
          IoTWireless.GetResourcePositionHttp,
          IoTWireless.UpdateResourcePositionHttp,
          IoTWireless.GetWirelessGatewayStatisticsHttp,
          IoTWireless.GetServiceEndpointHttp,
          IoTWireless.GetPositionEstimateHttp,
          Lambda.WirelessDestinationEventSource,
          AWS.SQS.QueueSinkHttp,
        ),
        Layer.mergeAll(AWS.SQS.SendMessageBatchHttp, ResultQueueLive),
      ),
    ),
  ),
);

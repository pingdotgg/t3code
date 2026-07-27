import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import IoTWirelessTestFunctionLive, {
  IoTWirelessTestFunction,
} from "./fixtures/handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "IoTWirelessBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(60),
]);

let baseUrl: string;
let resultQueueUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// POST a fixture route; retry 5xx (cold-start IAM propagation surfaces as
// a typed-error 500 from the fixture until the fresh role policy is
// visible to IoT Wireless).
const post = (path: string) =>
  HttpClient.execute(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(6),
      ]),
    }),
  );

const postJson = (path: string) =>
  post(path).pipe(Effect.flatMap((response) => response.json));

describe("IoTWireless Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "IoTWireless test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("IoTWireless test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* IoTWirelessTestFunction;
        }).pipe(Effect.provide(IoTWirelessTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `IoTWireless test setup: probing readiness at ${readinessUrl}`,
      );
      // Ride out cold-start / URL propagation until /ping reports the
      // result queue (early invocations can briefly resolve outputs late).
      const ready = yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? (response.json as Effect.Effect<{
                ok: boolean;
                resultQueueUrl?: string;
              }>)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.flatMap((body) =>
          body.resultQueueUrl
            ? Effect.succeed(body as { resultQueueUrl: string })
            : Effect.fail(new Error("no result queue url yet")),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `IoTWireless test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      resultQueueUrl = ready.resultQueueUrl;
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 180_000,
  });

  describe("GetServiceEndpoint", () => {
    test.provider(
      "reads the account's LNS endpoint",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/service-endpoint")) as {
            serviceType: string | null;
            serviceEndpoint: string | null;
          };
          expect(response.serviceType).toBe("LNS");
          expect(response.serviceEndpoint).toBeTruthy();
        }),
      { timeout: 120_000 },
    );
  });

  describe("SendDataToWirelessDevice", () => {
    test.provider(
      "queues a downlink to the bound ABP device",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/send")) as {
            messageId: string | null;
          };
          expect(response.messageId).toBeTruthy();
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListQueuedMessages", () => {
    test.provider(
      "sees the queued downlink",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/queued").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (r): boolean => (r as { count: number }).count >= 1,
              times: 15,
            }),
          )) as { count: number; messageIds: (string | null)[] };
          expect(response.count).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 120_000 },
    );
  });

  describe("DeleteQueuedMessages", () => {
    test.provider(
      "purges the downlink queue",
      (_stack) =>
        Effect.gen(function* () {
          const purge = (yield* postJson("/purge")) as { ok: boolean };
          expect(purge.ok).toBe(true);

          const drained = (yield* postJson("/queued").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (r): boolean => (r as { count: number }).count === 0,
              times: 15,
            }),
          )) as { count: number };
          expect(drained.count).toBe(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetWirelessDeviceStatistics", () => {
    test.provider(
      "reads the bound device's operating information",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/device-stats")) as {
            wirelessDeviceId: string | null;
          };
          expect(response.wirelessDeviceId).toBeTruthy();
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetWirelessGatewayStatistics", () => {
    test.provider(
      "reads the bound gateway's connection status",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/gateway-stats")) as {
            wirelessGatewayId: string | null;
            connectionStatus: string | null;
          };
          expect(response.wirelessGatewayId).toBeTruthy();
        }),
      { timeout: 120_000 },
    );
  });

  describe("UpdateResourcePosition + GetResourcePosition", () => {
    test.provider(
      "writes a static position and reads it back",
      (_stack) =>
        Effect.gen(function* () {
          const updated = (yield* postJson("/update-position")) as {
            ok: boolean;
          };
          expect(updated.ok).toBe(true);

          const read = (yield* postJson("/position").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (r): boolean =>
                typeof (r as { geoJson: string | null }).geoJson === "string" &&
                ((r as { geoJson: string }).geoJson.includes("-122.33") ||
                  (r as { geoJson: string }).geoJson.includes("coordinates")),
              times: 10,
            }),
          )) as { geoJson: string | null };
          expect(read.geoJson).toBeTruthy();
          const parsed = JSON.parse(read.geoJson!) as {
            coordinates?: number[];
          };
          expect(parsed.coordinates?.[0]).toBeCloseTo(-122.33, 2);
          expect(parsed.coordinates?.[1]).toBeCloseTo(47.61, 2);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetPositionEstimate", () => {
    test.provider(
      "invokes the position solver with fabricated WiFi scans",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/position-estimate")) as {
            ok: boolean;
            tag?: string;
            geoJson?: string | null;
          };
          // Fabricated MACs may not resolve to a position — the solver
          // then returns a typed not-found/validation error. Either way the
          // IAM grant and the call path are proven (an access failure
          // would surface as a retried-then-failing 500 instead).
          if (response.ok) {
            expect(response.geoJson).toBeTruthy();
          } else {
            expect([
              "ResourceNotFoundException",
              "ValidationException",
            ]).toContain(response.tag);
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("TestWirelessDevice", () => {
    test.provider(
      "simulates an uplink from the bound device",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/test-device")) as {
            result: string | null;
          };
          expect(response.result).toBeTruthy();
        }),
      { timeout: 120_000 },
    );
  });

  describe("DestinationEventSource (consumeUplinks)", () => {
    test.provider(
      "routes a simulated uplink through the destination's rule into the handler",
      (_stack) =>
        Effect.gen(function* () {
          const { wirelessDeviceId } = (yield* postJson("/device-stats")) as {
            wirelessDeviceId: string;
          };
          expect(wirelessDeviceId).toBeTruthy();

          // Fire a simulated "Hello" uplink; IoT Wireless routes it through
          // the destination's rule, which invokes the fixture Lambda, whose
          // consumeUplinks handler forwards the envelope into the result
          // queue. Re-fire on each poll retry to ride out rule/permission
          // propagation on a fresh deploy.
          yield* postJson("/test-device");

          const body = yield* Effect.gen(function* () {
            const received = yield* SQS.receiveMessage({
              QueueUrl: resultQueueUrl,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 2,
            });
            const match = (received.Messages ?? []).find((message) =>
              message.Body?.includes(wirelessDeviceId),
            );
            if (!match?.ReceiptHandle) {
              yield* postJson("/test-device").pipe(Effect.ignore);
              return yield* Effect.fail(new UplinkNotDelivered());
            }
            yield* SQS.deleteMessage({
              QueueUrl: resultQueueUrl,
              ReceiptHandle: match.ReceiptHandle,
            });
            return match.Body!;
          }).pipe(
            Effect.retry({
              while: (error): boolean => error._tag === "UplinkNotDelivered",
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(40),
              ]),
            }),
          );

          const uplink = JSON.parse(body) as {
            WirelessDeviceId: string;
            PayloadData: string;
          };
          expect(uplink.WirelessDeviceId).toBe(wirelessDeviceId);
          expect(uplink.PayloadData).toBeTruthy();
        }),
      { timeout: 240_000 },
    );
  });
});

class UplinkNotDelivered extends Data.TaggedError("UplinkNotDelivered") {}

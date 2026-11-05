import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { Region } from "@distilled.cloud/aws/Region";
import * as SQS from "@distilled.cloud/aws/sqs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import {
  EndpointInfra,
  EndpointTestFunction,
  EndpointTestFunctionLive,
  EndpointInfraLive,
  type EndpointInfraOptions,
  secondaryRegionOf,
} from "./fixtures/endpoint-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

const describeEndpoint = (name: string) =>
  eventbridge
    .describeEndpoint({ Name: name })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)));

const describeBus = (name: string, region: string) =>
  eventbridge.describeEventBus({ Name: name }).pipe(
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
    Effect.provideService(Region, Effect.succeed(region)),
  );

class FunctionNotReady extends Data.TaggedError("FunctionNotReady")<{ status: number }> {}
class EventNotDelivered extends Data.TaggedError("EventNotDelivered") {}

const deployFixture = (stack: Test.ScratchStack, options: EndpointInfraOptions) =>
  stack.deploy(
    Effect.gen(function* () {
      const { primary, secondary, endpoint, queue } = yield* EndpointInfra;
      const fn = yield* EndpointTestFunction;
      return { primary, secondary, endpoint, queue, fn };
    }).pipe(
      Effect.provide(Layer.mergeAll(EndpointTestFunctionLive(options), EndpointInfraLive(options))),
    ),
  );

/**
 * Publish through the endpoint from the Lambda (SigV4A-signed PutEvents) and
 * wait for the event on the primary bus's sink queue. The rule is new, so
 * events published before it propagates are dropped: re-publish each round.
 */
const publishUntilReceived = Effect.fn(function* (
  baseUrl: string,
  queueUrl: string,
  marker: string,
) {
  yield* HttpClient.get(`${baseUrl}/health`).pipe(
    Effect.flatMap((res) =>
      res.status === 200 ? Effect.void : Effect.fail(new FunctionNotReady({ status: res.status })),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 45 }),
  );
  return yield* Effect.gen(function* () {
    const res = yield* HttpClient.execute(
      HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(`${baseUrl}/publish`), { marker }),
    );
    const text = yield* res.text;
    expect(res.status, text).toBe(200);
    const published = JSON.parse(text) as {
      failedEntryCount: number;
      entries: Array<{ EventId?: string }>;
    };
    expect(published.failedEntryCount, text).toBe(0);
    expect(published.entries[0]?.EventId).toBeTruthy();

    const received = yield* SQS.receiveMessage({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 5,
    });
    const match = (received.Messages ?? []).find((m) => m.Body?.includes(marker));
    if (!match) return yield* new EventNotDelivered();
    return JSON.parse(match.Body!) as { source: string; detail: { marker: string } };
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "EventNotDelivered",
      schedule: Schedule.spaced("3 seconds"),
      times: 12,
    }),
  );
});

test.provider(
  "global endpoint: create, publish through it, update in place, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const secondaryRegion = secondaryRegionOf(yield* yield* Region);

      const created = yield* deployFixture(stack, { description: "initial", replication: true });
      const { endpoint, primary, secondary } = created;

      expect(endpoint.endpointArn).toContain(`:endpoint/${endpoint.endpointName}`);
      expect(endpoint.endpointUrl).toContain(endpoint.endpointId);
      expect(endpoint.eventBusArns).toEqual([primary.eventBusArn, secondary.eventBusArn]);
      // The secondary bus lives in the failover region under the same name.
      expect(secondary.eventBusName).toBe(primary.eventBusName);
      expect(secondary.eventBusArn).toContain(`:events:${secondaryRegion}:`);
      expect((yield* describeBus(secondary.eventBusName, secondaryRegion))?.Arn).toBe(
        secondary.eventBusArn,
      );

      const live = yield* describeEndpoint(endpoint.endpointName);
      expect(live?.State).toBe("ACTIVE");
      expect(live?.Description).toBe("initial");
      expect(live?.ReplicationConfig?.State).toBe("ENABLED");
      expect(live?.RoutingConfig?.FailoverConfig?.Secondary?.Route).toBe(secondaryRegion);
      expect(live?.RoutingConfig?.FailoverConfig?.Primary?.HealthCheck).toMatch(
        /^arn:aws:route53:::healthcheck\//,
      );

      // A caller signing for another region — any publisher after a
      // failover, or one running in the secondary region — still reaches the
      // endpoint: its SigV4A signature is valid in every region, where a
      // region-scoped SigV4 one fails with "Credential should be scoped to a
      // valid region".
      const fromSecondary = yield* eventbridge
        .putEvents({
          EndpointId: endpoint.endpointId,
          Entries: [
            {
              Source: "alchemy.test.endpoint",
              DetailType: "FromSecondaryRegion",
              Detail: "{}",
              EventBusName: primary.eventBusName,
            },
          ],
        })
        .pipe(Effect.provideService(Region, Effect.succeed(secondaryRegion)));
      expect(fromSecondary.FailedEntryCount ?? 0).toBe(0);

      const event = yield* publishUntilReceived(
        created.fn.functionUrl!.replace(/\/+$/, ""),
        created.queue.queueUrl,
        "through-global-endpoint",
      );
      expect(event.source).toBe("alchemy.test.endpoint");
      expect(event.detail.marker).toBe("through-global-endpoint");

      // Description and replication update in place: same endpoint id.
      const updated = yield* deployFixture(stack, { description: "updated", replication: false });
      expect(updated.endpoint.endpointId).toBe(endpoint.endpointId);
      const afterUpdate = yield* describeEndpoint(endpoint.endpointName);
      expect(afterUpdate?.State).toBe("ACTIVE");
      expect(afterUpdate?.Description).toBe("updated");
      expect(afterUpdate?.ReplicationConfig?.State).toBe("DISABLED");

      yield* stack.destroy();

      expect(yield* describeEndpoint(endpoint.endpointName)).toBeUndefined();
      expect(yield* describeBus(secondary.eventBusName, secondaryRegion)).toBeUndefined();
      expect(yield* describeBus(primary.eventBusName, yield* yield* Region)).toBeUndefined();
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:eventbridge",
      "provider:aws:lambda",
      "provider:aws:route53",
      "live",
    ],
    timeout: 420_000,
  },
);

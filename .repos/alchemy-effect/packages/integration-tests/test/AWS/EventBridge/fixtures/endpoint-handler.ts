import * as AWS from "@alchemy.run/aws";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** The rules EventBridge manages on a global endpoint's bus, from the bus ARN. */
const managedRuleArnOf = (eventBusArn: string) =>
  `${eventBusArn.replace(":event-bus/", ":rule/")}/GlobalEndpointManagedRule-*`;

const REPLICATION_PATH = "/eventbridge-replication/";

/** Roles on the replication path in the bus's account, from the bus ARN. */
const replicationRolesOf = (eventBusArn: string) =>
  `arn:aws:iam::${eventBusArn.split(":")[4]}:role${REPLICATION_PATH}*`;

/** The failover region: any region other than the stack's. */
export const secondaryRegionOf = (region: string) =>
  region === "us-east-1" ? "us-east-2" : "us-east-1";

/**
 * A global endpoint over a same-named bus in the stack's region and in
 * {@link secondaryRegionOf}, failing over on an always-healthy calculated
 * health check. A rule on the primary bus routes the fixture's events to an
 * SQS queue the test reads out-of-band.
 */
export class EndpointInfra extends Context.Service<
  EndpointInfra,
  {
    primary: AWS.EventBridge.EventBus;
    secondary: AWS.EventBridge.EventBus;
    endpoint: AWS.EventBridge.Endpoint;
    queue: AWS.SQS.Queue;
  }
>()("EventBridgeEndpointInfra") {}

export interface EndpointInfraOptions {
  description: string;
  replication: boolean;
}

export const EndpointInfraLive = (options: EndpointInfraOptions) =>
  Layer.effect(
    EndpointInfra,
    Effect.gen(function* () {
      // The region is configuration: report a missing one as a ConfigError.
      const region = yield* (yield* AWS.Region).pipe(
        Effect.mapError(
          (e) =>
            new Config.ConfigError(
              e._tag === "SourceError" ? e : new ConfigProvider.SourceError({ message: e.message }),
            ),
        ),
      );
      const secondaryRegion = secondaryRegionOf(region);

      const primary = yield* AWS.EventBridge.EventBus("PrimaryBus", {
        forceDestroy: true,
      });
      // Both buses of a global endpoint must share a name.
      const secondary = yield* AWS.EventBridge.EventBus("SecondaryBus", {
        name: primary.eventBusName,
        region: secondaryRegion,
        forceDestroy: true,
      });
      // No children and a threshold of 0: always healthy, so events stay in
      // the primary region.
      const health = yield* AWS.Route53.HealthCheck("PrimaryHealth", {
        type: "CALCULATED",
        healthThreshold: 0,
        childHealthChecks: [],
      });
      const role = yield* AWS.IAM.Role("ReplicationRole", {
        path: REPLICATION_PATH,
        assumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "events.amazonaws.com" },
              Action: ["sts:AssumeRole"],
            },
          ],
        },
        inlinePolicies: {
          Replicate: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["events:PutEvents"],
                Resource: [primary.eventBusArn, secondary.eventBusArn],
              },
              // EventBridge manages a replication rule on each bus.
              {
                Effect: "Allow",
                Action: [
                  "events:PutRule",
                  "events:PutTargets",
                  "events:DeleteRule",
                  "events:RemoveTargets",
                ],
                Resource: [primary.eventBusArn, secondary.eventBusArn].map((arn) =>
                  arn.pipe(Output.map(managedRuleArnOf)),
                ),
              },
              // EventBridge passes this role to its managed rules' targets;
              // only roles on the replication path can be passed, and only
              // to EventBridge.
              {
                Effect: "Allow",
                Action: ["iam:PassRole"],
                Resource: [primary.eventBusArn.pipe(Output.map(replicationRolesOf))],
                Condition: { StringEquals: { "iam:PassedToService": "events.amazonaws.com" } },
              },
            ],
          },
        },
      });
      const endpoint = yield* AWS.EventBridge.Endpoint("GlobalEndpoint", {
        description: options.description,
        eventBuses: [primary.eventBusArn, secondary.eventBusArn],
        failover: {
          healthCheck: health.healthCheckId,
          secondaryRegion,
        },
        replication: options.replication,
        roleArn: role.roleArn,
      });

      // The delivery policy is a plain prop so the Queue never depends on
      // the Rule (see sink-handler.ts).
      const queue = yield* AWS.SQS.Queue("EndpointSinkQueue", {
        policy: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "events.amazonaws.com" },
              Action: "sqs:SendMessage",
              Resource: "*",
            },
          ],
        },
      });
      yield* AWS.EventBridge.Rule("EndpointSinkRoute", {
        eventBusName: primary.eventBusName,
        eventPattern: { source: ["alchemy.test.endpoint"] },
        targets: [{ Id: "EndpointSinkQueueTarget", Arn: queue.queueArn as any }],
      });
      return { primary, secondary, endpoint, queue };
    }),
  );

export class EndpointTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "EndpointTestFunction",
) {}

export const EndpointTestFunctionLive = (options: EndpointInfraOptions) =>
  EndpointTestFunction.make(
    {
      main: import.meta.url,
      functionUrl: true,
    },
    Effect.gen(function* () {
      const { endpoint } = yield* EndpointInfra;
      const putEvents = yield* AWS.EventBridge.PutEvents(endpoint);

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const pathname = new URL(request.originalUrl).pathname;

          if (request.method === "GET" && pathname === "/health") {
            return yield* HttpServerResponse.json({ ok: true });
          }

          if (request.method === "POST" && pathname === "/publish") {
            const body = (yield* request.json) as unknown as { marker: string };
            const result = yield* putEvents({
              Entries: [
                {
                  Source: "alchemy.test.endpoint",
                  DetailType: "EndpointEvent",
                  Detail: JSON.stringify({ marker: body.marker }),
                },
              ],
            });
            return yield* HttpServerResponse.json({
              failedEntryCount: result.FailedEntryCount ?? 0,
              entries: result.Entries ?? [],
            });
          }

          return yield* HttpServerResponse.json(
            { error: "Not found", method: request.method, pathname },
            { status: 404 },
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(
              HttpServerResponse.text(`Internal server error: ${String(error)}`, {
                status: 500,
              }),
            ),
          ),
        ),
      };
    }).pipe(
      Effect.provide(Layer.mergeAll(EndpointInfraLive(options), AWS.EventBridge.PutEventsHttp)),
    ),
  );

export default EndpointTestFunctionLive({ description: "initial", replication: true });

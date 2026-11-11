import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type { EndpointState } from "@distilled.cloud/aws/eventbridge";

export type EndpointName = string;
export type EndpointArn = `arn:aws:events:${RegionID}:${AccountID}:endpoint/${EndpointName}`;

export interface EndpointFailoverConfig {
  /**
   * The Route 53 health check that decides when to fail over: while it is
   * unhealthy, events sent to the endpoint go to the secondary region.
   * Accepts the health check ID (`healthCheck.healthCheckId`) or its ARN.
   */
  healthCheck: string;
  /**
   * The region events are routed to while the health check is unhealthy.
   * It must be the region of the second event bus in `eventBuses`.
   */
  secondaryRegion: string;
}

export interface EndpointProps {
  /**
   * Name of the endpoint. Must match [\.\-_A-Za-z0-9]+, 1-64 characters.
   * If omitted, a unique name will be generated. Changing it replaces the
   * endpoint.
   */
  name?: EndpointName;

  /**
   * Description of the endpoint. Max 512 characters.
   */
  description?: string;

  /**
   * ARNs of the two event buses the endpoint routes to: the primary bus in
   * the stack's region and the secondary bus in `failover.secondaryRegion`.
   * Both buses must have the same name.
   */
  eventBuses: [primary: string, secondary: string];

  /**
   * When to fail over, and to which region.
   */
  failover: EndpointFailoverConfig;

  /**
   * Whether events are replicated to the secondary region's bus, so they
   * keep being processed there after a failover.
   * @default true
   */
  replication?: boolean;

  /**
   * ARN of the IAM role EventBridge assumes to replicate events. It must
   * trust `events.amazonaws.com`, allow `events:PutEvents` on both buses, and
   * let EventBridge manage its replication rule on each bus
   * (`rule/<bus>/GlobalEndpointManagedRule-*`) and pass the role to that rule's
   * target (`iam:PassRole` on the role, for `events.amazonaws.com`). See the
   * `Endpoint` examples for a least-privilege policy.
   * Required when `replication` is enabled.
   */
  roleArn?: string;
}

/** The endpoint ended in `CREATE_FAILED` or `UPDATE_FAILED`. */
export class EndpointFailed extends Data.TaggedError("EndpointFailed")<{
  readonly endpointName: string;
  readonly state: string;
  readonly reason: string | undefined;
}> {
  override get message() {
    return `Endpoint ${this.endpointName} is ${this.state}: ${this.reason ?? "no reason given"}`;
  }
}

/**
 * An Amazon EventBridge global endpoint: one URL for publishing events that
 * EventBridge routes to an event bus in the primary region, or to the
 * same-named bus in a secondary region when a Route 53 health check fails.
 *
 * Create the same-named bus in both regions, a health check that reflects
 * the primary region's health, and (for replication) a role EventBridge can
 * use to forward events to the secondary bus. Publish through the endpoint by
 * passing it to the `PutEvents` binding.
 *
 * Endpoints do not support tags, so ownership is tracked by the
 * deterministic physical name.
 * ### Creating a Global Endpoint
 * **Example:** Fail Over Between Two Regions
 * ```typescript
 * const primary = yield* AWS.EventBridge.EventBus("Primary", { name: "orders" });
 * const secondary = yield* AWS.EventBridge.EventBus("Secondary", {
 *   name: "orders",
 *   region: "us-east-2",
 * });
 *
 * // Healthy while the primary region's API answers its health route.
 * const health = yield* AWS.Route53.HealthCheck("PrimaryHealth", {
 *   type: "HTTPS",
 *   fullyQualifiedDomainName: "api.us-east-1.example.com",
 *   resourcePath: "/health",
 *   port: 443,
 * });
 *
 * const replication = yield* AWS.IAM.Role("ReplicationRole", {
 *   // `iam:PassRole` below is scoped to roles on this path.
 *   path: "/eventbridge-replication/",
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { Service: "events.amazonaws.com" },
 *         Action: "sts:AssumeRole",
 *       },
 *     ],
 *   },
 *   inlinePolicies: {
 *     Replicate: {
 *       Version: "2012-10-17",
 *       Statement: [
 *         {
 *           Effect: "Allow",
 *           Action: "events:PutEvents",
 *           Resource: [primary.eventBusArn, secondary.eventBusArn],
 *         },
 *         // EventBridge manages a replication rule on each bus.
 *         {
 *           Effect: "Allow",
 *           Action: [
 *             "events:PutRule",
 *             "events:PutTargets",
 *             "events:DeleteRule",
 *             "events:RemoveTargets",
 *           ],
 *           Resource: [
 *             "arn:aws:events:us-east-1:123456789012:rule/orders/GlobalEndpointManagedRule-*",
 *             "arn:aws:events:us-east-2:123456789012:rule/orders/GlobalEndpointManagedRule-*",
 *           ],
 *         },
 *         // ...and passes this role to those rules' targets.
 *         {
 *           Effect: "Allow",
 *           Action: "iam:PassRole",
 *           Resource: "arn:aws:iam::123456789012:role/eventbridge-replication/*",
 *           Condition: { StringEquals: { "iam:PassedToService": "events.amazonaws.com" } },
 *         },
 *       ],
 *     },
 *   },
 * });
 *
 * const endpoint = yield* AWS.EventBridge.Endpoint("Orders", {
 *   eventBuses: [primary.eventBusArn, secondary.eventBusArn],
 *   failover: {
 *     healthCheck: health.healthCheckId,
 *     secondaryRegion: "us-east-2",
 *   },
 *   roleArn: replication.roleArn,
 * });
 * ```
 *
 * **Example:** Fail Over Without Replication
 * ```typescript
 * const endpoint = yield* AWS.EventBridge.Endpoint("Orders", {
 *   eventBuses: [primary.eventBusArn, secondary.eventBusArn],
 *   failover: {
 *     healthCheck: health.healthCheckId,
 *     secondaryRegion: "us-east-2",
 *   },
 *   replication: false,
 * });
 * ```
 *
 * ### Publishing Through the Endpoint
 * **Example:** Publish from a Function
 * ```typescript
 * // init — bind the endpoint (provide AWS.EventBridge.PutEventsHttp)
 * const putEvents = yield* AWS.EventBridge.PutEvents(endpoint);
 *
 * // runtime — EventBridge routes the event to the healthy region
 * yield* putEvents({
 *   Entries: [
 *     {
 *       Source: "my.app",
 *       DetailType: "OrderCreated",
 *       Detail: JSON.stringify({ orderId: "123" }),
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export interface Endpoint extends Resource<
  "AWS.EventBridge.Endpoint",
  EndpointProps,
  {
    /** The name of the endpoint. */
    endpointName: EndpointName;
    /** The ARN of the endpoint. */
    endpointArn: EndpointArn;
    /** The ID of the endpoint, used as `EndpointId` when calling `PutEvents`. */
    endpointId: string;
    /** The URL events are published to. */
    endpointUrl: string;
    /** The ARNs of the primary and secondary event buses. */
    eventBusArns: string[];
  },
  never,
  Providers
> {}
export const Endpoint = Resource<Endpoint>("AWS.EventBridge.Endpoint");

type EndpointAttrs = Endpoint["Attributes"];

/** The ARN EventBridge expects for a Route 53 health check, from its ID or ARN. */
const toHealthCheckArn = (healthCheck: string) =>
  healthCheck.startsWith("arn:") ? healthCheck : `arn:aws:route53:::healthcheck/${healthCheck}`;

const toAttrs = (endpoint: eventbridge.DescribeEndpointResponse): EndpointAttrs => ({
  endpointName: endpoint.Name!,
  endpointArn: endpoint.Arn as EndpointArn,
  endpointId: endpoint.EndpointId ?? "",
  endpointUrl: endpoint.EndpointUrl ?? "",
  eventBusArns: (endpoint.EventBuses ?? []).map((bus) => bus.EventBusArn),
});

export const EndpointProvider = () =>
  Provider.effect(
    Endpoint,
    Effect.gen(function* () {
      const createEndpointName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({
              id,
              maxLength: 64,
            });

      const describe = (name: string) =>
        eventbridge
          .describeEndpoint({ Name: name })
          .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));

      /**
       * Poll until the endpoint leaves CREATING/UPDATING. Endpoints settle in
       * well under a minute; the wait is bounded so a stuck endpoint surfaces
       * instead of hanging, and a failed one surfaces its reason.
       */
      const awaitSettled = (name: string) =>
        eventbridge.describeEndpoint({ Name: name }).pipe(
          // A describe fired immediately after create can be eventually
          // consistent — absorb NotFound briefly before polling the state.
          Effect.retry({
            while: (e): boolean => e._tag === "ResourceNotFoundException",
            schedule: Schedule.spaced("1 second"),
            times: 5,
          }),
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (r): boolean => r.State !== "CREATING" && r.State !== "UPDATING",
            times: 30,
          }),
        );

      const failed = (name: string, r: eventbridge.DescribeEndpointResponse) =>
        new EndpointFailed({ endpointName: name, state: r.State ?? "", reason: r.StateReason });

      /** Delete the endpoint and wait until it is gone. */
      const removeEndpoint = Effect.fn(function* (name: string) {
        yield* eventbridge.deleteEndpoint({ Name: name }).pipe(
          // An endpoint that is still CREATING/UPDATING rejects the delete.
          Effect.retry({
            while: (e): boolean => e._tag === "ConcurrentModificationException",
            schedule: Schedule.spaced("3 seconds"),
            times: 10,
          }),
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        );
        // Wait out DELETING so the same name can be recreated right away and
        // the buses it routes to can be deleted.
        yield* describe(name).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (r): boolean => r === undefined,
            times: 30,
          }),
        );
      });

      const createEndpoint = Effect.fn(function* (
        name: string,
        desired: Omit<eventbridge.CreateEndpointRequest, "Name">,
      ) {
        // Tolerate an AlreadyExists race with a peer reconciler; the settled
        // state is observed below either way.
        yield* eventbridge.createEndpoint({ Name: name, ...desired }).pipe(
          Effect.retry({
            // A freshly created replication role takes a few seconds to
            // become assumable by EventBridge (IAM propagation).
            while: (e): boolean => e._tag === "EndpointRoleNotAssumable",
            schedule: Schedule.spaced("3 seconds"),
            times: 15,
          }),
          Effect.catchTag("ResourceAlreadyExistsException", () => Effect.void),
        );
        const settled = yield* awaitSettled(name);
        if (settled.State === "CREATE_FAILED") {
          yield* removeEndpoint(name);
          return yield* failed(name, settled);
        }
        return settled;
      });

      const updateEndpoint = Effect.fn(function* (
        name: string,
        desired: Omit<eventbridge.UpdateEndpointRequest, "Name">,
      ) {
        yield* eventbridge.updateEndpoint({ Name: name, ...desired }).pipe(
          Effect.retry({
            while: (e): boolean => e._tag === "EndpointRoleNotAssumable",
            schedule: Schedule.spaced("3 seconds"),
            times: 15,
          }),
          Effect.retry({
            while: (e): boolean => e._tag === "ConcurrentModificationException",
            schedule: Schedule.spaced("3 seconds"),
            times: 10,
          }),
        );
        const settled = yield* awaitSettled(name);
        if (settled.State === "UPDATE_FAILED") return yield* failed(name, settled);
        return settled;
      });

      return {
        stables: ["endpointName", "endpointArn", "endpointId", "endpointUrl"],
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          const oldName = yield* createEndpointName(id, olds);
          const newName = yield* createEndpointName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          // Endpoints don't support tags; the deterministic physical name is
          // the ownership signal (it embeds app/stage/logical id).
          const name = output?.endpointName ?? (yield* createEndpointName(id, olds ?? {}));
          const described = yield* describe(name);
          if (!described?.Name || !described.Arn) {
            return undefined;
          }
          return toAttrs(described);
        }),
        list: () =>
          Effect.gen(function* () {
            const attrs: EndpointAttrs[] = [];
            let nextToken: string | undefined;
            do {
              const page = yield* eventbridge.listEndpoints({ NextToken: nextToken });
              for (const endpoint of page.Endpoints ?? []) {
                if (!endpoint.Name || !endpoint.Arn) continue;
                attrs.push(toAttrs(endpoint));
              }
              nextToken = page.NextToken;
            } while (nextToken);
            return attrs;
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.endpointName ?? (yield* createEndpointName(id, news));
          const desired = {
            Description: news.description,
            RoutingConfig: {
              FailoverConfig: {
                Primary: { HealthCheck: toHealthCheckArn(news.failover.healthCheck) },
                Secondary: { Route: news.failover.secondaryRegion },
              },
            },
            ReplicationConfig: {
              State: news.replication === false ? "DISABLED" : "ENABLED",
            },
            EventBuses: news.eventBuses.map((arn) => ({ EventBusArn: arn })),
            RoleArn: news.roleArn,
          } satisfies Omit<eventbridge.UpdateEndpointRequest, "Name">;

          // Observe — live cloud state is authoritative. A vanished endpoint
          // falls through to create, and so does one a previous run left in
          // CREATE_FAILED (it can never become ACTIVE).
          let observed = yield* describe(name);
          if (observed?.Arn) {
            observed = yield* awaitSettled(name);
            if (observed.State === "CREATE_FAILED") {
              yield* removeEndpoint(name);
              observed = undefined;
            }
          }

          // Ensure — create the endpoint and wait for it to settle. The
          // replication role is checked again after the endpoint is accepted:
          // while its policy is still propagating, the endpoint ends in
          // CREATE_FAILED ("does not grant EventBridge the PutRule
          // permission"), so a failed create is removed and retried.
          if (!observed?.Arn) {
            observed = yield* createEndpoint(name, desired).pipe(
              Effect.retry({
                while: (e): boolean => e._tag === "EndpointFailed",
                schedule: Schedule.spaced("10 seconds"),
                times: 3,
              }),
            );
          }

          // Sync — diff the observed configuration against the desired one
          // and update only when something differs (or the last update
          // failed).
          const drifted =
            observed.State === "UPDATE_FAILED" ||
            (observed.Description ?? "") !== (desired.Description ?? "") ||
            observed.RoutingConfig?.FailoverConfig?.Primary?.HealthCheck !==
              desired.RoutingConfig.FailoverConfig.Primary.HealthCheck ||
            observed.RoutingConfig?.FailoverConfig?.Secondary?.Route !==
              desired.RoutingConfig.FailoverConfig.Secondary.Route ||
            (observed.ReplicationConfig?.State ?? "ENABLED") !== desired.ReplicationConfig.State ||
            (observed.RoleArn ?? "") !== (desired.RoleArn ?? "") ||
            (observed.EventBuses ?? [])
              .map((bus) => bus.EventBusArn)
              .sort()
              .join(",") !== [...news.eventBuses].sort().join(",");
          if (drifted) {
            // Same propagation race as create, ending in UPDATE_FAILED.
            observed = yield* updateEndpoint(name, desired).pipe(
              Effect.retry({
                while: (e): boolean => e._tag === "EndpointFailed",
                schedule: Schedule.spaced("10 seconds"),
                times: 3,
              }),
            );
          }

          const attrs = toAttrs(observed);
          yield* session.note(attrs.endpointUrl);
          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* removeEndpoint(output.endpointName);
        }),
      };
    }),
  );

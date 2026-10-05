import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { canonicalCidr } from "../../Utils/ip-address.ts";
import type { Providers } from "../Providers.ts";
import type { ClientVpnEndpointId } from "./ClientVpnEndpoint.ts";
import { retryClientVpn } from "./ClientVpnWait.ts";
import type { SubnetId } from "./Subnet.ts";

/** Immutable settings for a manually added VPC-based Client VPN route. */
export interface ClientVpnRouteProps {
  /** The Client VPN endpoint. Changing this replaces the route. */
  clientVpnEndpointId: ClientVpnEndpointId;
  /** The destination IPv4 CIDR. Changing this replaces the route. */
  destinationCidrBlock: string;
  /**
   * The associated target subnet. Pass ClientVpnTargetNetworkAssociation.subnetId
   * to order creation and deletion after and before the association respectively.
   * Changing this replaces the route.
   */
  targetVpcSubnetId: SubnetId;
  /** A description of the route. Changing this replaces the route. */
  description?: string;
}

/** A manually added route in a Client VPN endpoint's route table. */
export interface ClientVpnRoute extends Resource<
  "AWS.EC2.ClientVpnRoute",
  ClientVpnRouteProps,
  {
    /** The Client VPN endpoint containing the route. */
    clientVpnEndpointId: ClientVpnEndpointId;
    /** The canonical destination network CIDR. */
    destinationCidrBlock: string;
    /** The associated subnet through which traffic is routed. */
    targetVpcSubnetId: SubnetId;
    /** The observed route description. */
    description: string | undefined;
    /** How AWS created the route: add-route for manual routes, associate for automatic routes. */
    origin: string | undefined;
    /** The observed route type. */
    type: string | undefined;
    /** The current route state. */
    status: ec2.ClientVpnRouteStatusCode;
    /** Additional information about the route state. */
    statusMessage: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Adds a destination route through a Client VPN target subnet. The target must
 * already be associated; reference the association's subnetId output, not the
 * subnet resource directly, to preserve deployment and teardown ordering.
 * Authorization rules are configured separately and are also required for access.
 *
 * All property changes require replacement. Description-only changes delete the
 * old route first because AWS has no modify-route API. AWS-created local routes
 * cannot be managed or deleted with this resource. This resource manages the
 * declared endpoint/destination/subnet identity, including an existing manual
 * route discovered without cached state. Routes have no independent ownership
 * markers.
 *
 * Readiness waits default to 30 minutes. Set `AWS_CLIENT_VPN_TIMEOUT` to a
 * positive finite duration, such as `45 minutes`, to override this deadline.
 *
 * ### Routing Client Traffic
 * **Example:** Route internet traffic through an associated subnet
 * ```typescript
 * const target = yield* AWS.EC2.ClientVpnTargetNetworkAssociation("VpnTarget", {
 *   clientVpnEndpointId: endpoint.clientVpnEndpointId,
 *   subnetId: publicSubnet.subnetId,
 * });
 * const route = yield* AWS.EC2.ClientVpnRoute("VpnInternetRoute", {
 *   clientVpnEndpointId: target.clientVpnEndpointId,
 *   targetVpcSubnetId: target.subnetId,
 *   destinationCidrBlock: "0.0.0.0/0",
 *   description: "Internet egress",
 * });
 * ```
 *
 * The subnet's VPC routing must provide the required egress path. For multiple
 * target associations, add the same destination through each target subnet so
 * clients have consistent access regardless of which association serves them.
 *
 * @resource
 */
export const ClientVpnRoute = Resource<ClientVpnRoute>(
  "AWS.EC2.ClientVpnRoute",
);

class ClientVpnRoutePending extends Data.TaggedError("ClientVpnRoutePending")<{
  message: string;
}> {}

class ClientVpnRouteFailed extends Data.TaggedError("ClientVpnRouteFailed")<{
  message: string;
}> {}

const routes = (clientVpnEndpointId: ClientVpnEndpointId) =>
  ec2.describeClientVpnRoutes
    .items({ ClientVpnEndpointId: clientVpnEndpointId })
    .pipe(
      Stream.runCollect,
      Effect.map((items) =>
        items.filter((route) => route.Status?.Code !== "deleted"),
      ),
      Effect.catchTag("InvalidClientVpnEndpointId.NotFound", () =>
        Effect.succeed([] as ec2.ClientVpnRoute[]),
      ),
    );

const findRoute = (props: ClientVpnRouteProps) =>
  routes(props.clientVpnEndpointId).pipe(
    Effect.map((items) =>
      items.find(
        (route) =>
          canonicalCidr(route.DestinationCidr) ===
            canonicalCidr(props.destinationCidrBlock) &&
          route.TargetSubnet === props.targetVpcSubnetId,
      ),
    ),
  );

const toAttributes = (
  clientVpnEndpointId: ClientVpnEndpointId,
  route: ec2.ClientVpnRoute,
): ClientVpnRoute["Attributes"] => ({
  clientVpnEndpointId,
  destinationCidrBlock: route.DestinationCidr!,
  targetVpcSubnetId: route.TargetSubnet as SubnetId,
  description: route.Description,
  origin: route.Origin,
  type: route.Type,
  status: route.Status?.Code ?? "creating",
  statusMessage: route.Status?.Message,
});

const requireManualRoute = (route: ec2.ClientVpnRoute) =>
  route.Origin === "add-route"
    ? Effect.void
    : Effect.fail(
        new ClientVpnRouteFailed({
          message: `Client VPN route ${route.DestinationCidr} has origin ${route.Origin ?? "unknown"}; only manually added routes can be managed.`,
        }),
      );

const waitForRoute = (props: ClientVpnRouteProps, deleted: boolean) =>
  Effect.gen(function* () {
    const route = yield* findRoute(props);
    if (deleted && !route) return undefined;
    if (route) yield* requireManualRoute(route);
    if (!deleted && route?.Status?.Code === "active") return route;
    if (!deleted && route?.Status?.Code === "failed") {
      return yield* new ClientVpnRouteFailed({
        message: route.Status.Message ?? "Client VPN route creation failed",
      });
    }
    return yield* new ClientVpnRoutePending({
      message: `Client VPN route ${props.destinationCidrBlock} is ${route?.Status?.Code ?? "not visible"}; waiting for ${deleted ? "deletion" : "active"}`,
    });
  }).pipe((effect) =>
    retryClientVpn(effect, (error) => error._tag === "ClientVpnRoutePending"),
  );

const removeRoute = Effect.fn(function* (props: ClientVpnRouteProps) {
  const route = yield* findRoute(props);
  if (!route) return;
  yield* requireManualRoute(route);
  if (route.Status?.Code !== "deleting") {
    yield* ec2
      .deleteClientVpnRoute({
        ClientVpnEndpointId: props.clientVpnEndpointId,
        DestinationCidrBlock: canonicalCidr(props.destinationCidrBlock),
        TargetVpcSubnetId: props.targetVpcSubnetId,
      })
      .pipe(
        Effect.catchTag(
          [
            "InvalidClientVpnEndpointId.NotFound",
            "InvalidClientVpnRouteNotFound",
          ],
          () => Effect.void,
        ),
        (effect) =>
          retryClientVpn(effect, (error) => error._tag === "IncorrectState"),
      );
  }
  yield* waitForRoute(props, true);
});

/** Live AWS provider for ClientVpnRoute. */
export const ClientVpnRouteProvider = () =>
  Provider.effect(
    ClientVpnRoute,
    Effect.gen(function* () {
      return {
        stables: [
          "clientVpnEndpointId",
          "destinationCidrBlock",
          "targetVpcSubnetId",
        ],
        nuke: {
          dependsOn: [
            "AWS.EC2.ClientVpnTargetNetworkAssociation",
            "AWS.EC2.ClientVpnEndpoint",
          ],
        },
        list: Effect.fn(function* () {
          const endpoints = yield* ec2.describeClientVpnEndpoints
            .items({})
            .pipe(Stream.runCollect);
          const items = yield* Effect.forEach(endpoints, (endpoint) =>
            routes(endpoint.ClientVpnEndpointId as ClientVpnEndpointId).pipe(
              Effect.map((items) =>
                items
                  .filter(
                    (route) =>
                      route.Origin === "add-route" &&
                      route.TargetSubnet?.startsWith("subnet-"),
                  )
                  .map((route) =>
                    toAttributes(
                      endpoint.ClientVpnEndpointId as ClientVpnEndpointId,
                      route,
                    ),
                  ),
              ),
            ),
          );
          return items.flat();
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const props = output ?? olds;
          const route = yield* findRoute(props);
          if (!route) return undefined;
          yield* requireManualRoute(route);
          return toAttributes(props.clientVpnEndpointId, route);
        }),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) {
            return { action: "replace", deleteFirst: true };
          }
          const sameKey =
            news.clientVpnEndpointId === olds.clientVpnEndpointId &&
            canonicalCidr(news.destinationCidrBlock) ===
              canonicalCidr(olds.destinationCidrBlock) &&
            news.targetVpcSubnetId === olds.targetVpcSubnetId;
          if (
            !sameKey ||
            news.destinationCidrBlock !== olds.destinationCidrBlock ||
            news.description !== olds.description
          ) {
            return { action: "replace", deleteFirst: sameKey };
          }
          const route = yield* findRoute(news);
          if (!route) return { action: "update" };
          yield* requireManualRoute(route);
          if (
            (route.Description ?? "") !== (news.description ?? "") ||
            route.Status?.Code === "failed"
          ) {
            return { action: "replace", deleteFirst: true };
          }
          if (route.Status?.Code !== "active") return { action: "update" };
        }),
        reconcile: Effect.fn(function* ({ news }) {
          let route = yield* findRoute(news);
          if (route) yield* requireManualRoute(route);
          if (
            route &&
            (route.Status?.Code === "deleting" ||
              (route.Description ?? "") !== (news.description ?? ""))
          ) {
            yield* removeRoute(news);
            route = undefined;
          }
          if (!route) {
            // Do not replay a completed create token after out-of-band deletion.
            const clientToken = yield* Effect.sync(() => crypto.randomUUID());
            yield* ec2
              .createClientVpnRoute({
                ClientVpnEndpointId: news.clientVpnEndpointId,
                DestinationCidrBlock: canonicalCidr(news.destinationCidrBlock),
                TargetVpcSubnetId: news.targetVpcSubnetId,
                Description: news.description,
                ClientToken: clientToken,
              })
              .pipe(
                Effect.catchTag(
                  "InvalidClientVpnDuplicateRoute",
                  () => Effect.void,
                ),
                (effect) =>
                  retryClientVpn(
                    effect,
                    (error) => error._tag === "IncorrectState",
                  ),
              );
          }
          const active = yield* waitForRoute(news, false);
          return toAttributes(news.clientVpnEndpointId, active!);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* removeRoute(output);
        }),
      };
    }),
  );

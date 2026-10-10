import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { ClientVpnEndpointId } from "./ClientVpnEndpoint.ts";
import { retryClientVpn } from "./ClientVpnWait.ts";
import type { SubnetId } from "./Subnet.ts";
import type { VpcId } from "./Vpc.ts";

/** The identifier of a Client VPN target network association. */
export type ClientVpnTargetNetworkAssociationId = `cvpn-assoc-${string}`;

/** Immutable settings for a VPC-based Client VPN target network association. */
export interface ClientVpnTargetNetworkAssociationProps {
  /** The Client VPN endpoint to associate. Changing this replaces the association. */
  clientVpnEndpointId: ClientVpnEndpointId;
  /**
   * The target subnet. All targets must belong to the endpoint's VPC, with at
   * most one subnet per Availability Zone. Changing this replaces the association.
   */
  subnetId: SubnetId;
}

/** A subnet associated with a Client VPN endpoint. */
export interface ClientVpnTargetNetworkAssociation extends Resource<
  "AWS.EC2.ClientVpnTargetNetworkAssociation",
  ClientVpnTargetNetworkAssociationProps,
  {
    /** The AWS-generated association identifier. */
    associationId: ClientVpnTargetNetworkAssociationId;
    /** The associated Client VPN endpoint. */
    clientVpnEndpointId: ClientVpnEndpointId;
    /** The associated subnet; reference this output from ClientVpnRoute for ordering. */
    subnetId: SubnetId;
    /** The VPC containing the target subnet. */
    vpcId: VpcId;
    /** The observed association state. */
    status: ec2.AssociationStatusCode;
    /** Additional information about the association state. */
    statusMessage: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Associates a VPC subnet with a Client VPN endpoint and waits for it to become
 * associated. AWS automatically adds the VPC's local route; do not manage that
 * automatic route with ClientVpnRoute. Security groups are endpoint-wide settings.
 * Association and disassociation can take several minutes. The provider waits
 * for AWS to finish, fails on association errors, and supports cancellation.
 *
 * All property changes replace the association. Replacement within the same
 * endpoint deletes first because AWS permits only one subnet per Availability
 * Zone. Removing the last association disconnects clients. This resource manages
 * the declared endpoint/subnet pair, including an existing association discovered
 * without cached state. Associations have no independent ownership markers.
 *
 * Readiness waits default to 30 minutes. Set `AWS_CLIENT_VPN_TIMEOUT` to a
 * positive finite duration, such as `45 minutes`, to override this deadline.
 *
 * ### Associating a Target Network
 * **Example:** Associate a subnet and order an internet route after it
 * ```typescript
 * const target = yield* AWS.EC2.ClientVpnTargetNetworkAssociation("VpnTarget", {
 *   clientVpnEndpointId: endpoint.clientVpnEndpointId,
 *   subnetId: privateSubnet.subnetId,
 * });
 * const route = yield* AWS.EC2.ClientVpnRoute("VpnInternet", {
 *   clientVpnEndpointId: target.clientVpnEndpointId,
 *   targetVpcSubnetId: target.subnetId,
 *   destinationCidrBlock: "0.0.0.0/0",
 * });
 * ```
 *
 * @resource
 */
export const ClientVpnTargetNetworkAssociation =
  Resource<ClientVpnTargetNetworkAssociation>(
    "AWS.EC2.ClientVpnTargetNetworkAssociation",
  );

class ClientVpnAssociationPending extends Data.TaggedError(
  "ClientVpnAssociationPending",
)<{ message: string }> {}

class ClientVpnAssociationFailed extends Data.TaggedError(
  "ClientVpnAssociationFailed",
)<{ message: string }> {}

const networks = (clientVpnEndpointId: ClientVpnEndpointId) =>
  ec2.describeClientVpnTargetNetworks
    .items({ ClientVpnEndpointId: clientVpnEndpointId })
    .pipe(
      Stream.runCollect,
      Effect.catchTag("InvalidClientVpnEndpointId.NotFound", () =>
        Effect.succeed([] as ec2.TargetNetwork[]),
      ),
    );

const findNetwork = (
  props: ClientVpnTargetNetworkAssociationProps,
  associationId?: string,
) =>
  networks(props.clientVpnEndpointId).pipe(
    Effect.map((items) =>
      items.find(
        (item) =>
          item.Status?.Code !== "disassociated" &&
          (associationId
            ? item.AssociationId === associationId
            : item.TargetNetworkId === props.subnetId),
      ),
    ),
  );

const toAttributes = (
  clientVpnEndpointId: ClientVpnEndpointId,
  network: ec2.TargetNetwork,
): ClientVpnTargetNetworkAssociation["Attributes"] => ({
  associationId: network.AssociationId as ClientVpnTargetNetworkAssociationId,
  clientVpnEndpointId,
  subnetId: network.TargetNetworkId as SubnetId,
  vpcId: network.VpcId as VpcId,
  status: network.Status?.Code ?? "associating",
  statusMessage: network.Status?.Message,
});

const waitForNetwork = (
  props: ClientVpnTargetNetworkAssociationProps,
  associationId: string | undefined,
  deleted: boolean,
) =>
  Effect.gen(function* () {
    const network = yield* findNetwork(props, associationId);
    if (deleted && !network) return undefined;
    if (!deleted && network?.Status?.Code === "associated") return network;
    if (!deleted && network?.Status?.Code === "association-failed") {
      return yield* new ClientVpnAssociationFailed({
        message:
          network.Status.Message ?? "Client VPN target association failed",
      });
    }
    return yield* new ClientVpnAssociationPending({
      message: `Client VPN association ${associationId ?? props.subnetId} is ${network?.Status?.Code ?? "not visible"}; waiting for ${deleted ? "disassociation" : "associated"}`,
    });
  }).pipe((effect) =>
    retryClientVpn(
      effect,
      (error) => error._tag === "ClientVpnAssociationPending",
    ),
  );

/** Live AWS provider for ClientVpnTargetNetworkAssociation. */
export const ClientVpnTargetNetworkAssociationProvider = () =>
  Provider.effect(
    ClientVpnTargetNetworkAssociation,
    Effect.gen(function* () {
      return {
        stables: ["associationId", "clientVpnEndpointId", "subnetId", "vpcId"],
        nuke: {
          dependsOn: [
            "AWS.EC2.ClientVpnEndpoint",
            "AWS.EC2.Subnet",
            "AWS.EC2.SecurityGroup",
          ],
        },
        list: Effect.fn(function* () {
          const endpoints = yield* ec2.describeClientVpnEndpoints
            .items({})
            .pipe(Stream.runCollect);
          const items = yield* Effect.forEach(endpoints, (endpoint) =>
            networks(endpoint.ClientVpnEndpointId as ClientVpnEndpointId).pipe(
              Effect.map((items) =>
                items
                  .filter(
                    (item) =>
                      item.AssociationId &&
                      item.TargetNetworkId?.startsWith("subnet-") &&
                      item.Status?.Code !== "disassociated",
                  )
                  .map((item) =>
                    toAttributes(
                      endpoint.ClientVpnEndpointId as ClientVpnEndpointId,
                      item,
                    ),
                  ),
              ),
            ),
          );
          return items.flat();
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const props = output ?? olds;
          const network = yield* findNetwork(props, output?.associationId);
          if (!network) return undefined;
          return toAttributes(props.clientVpnEndpointId, network);
        }),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) {
            return { action: "replace", deleteFirst: true };
          }
          if (
            news.clientVpnEndpointId !== olds.clientVpnEndpointId ||
            news.subnetId !== olds.subnetId
          ) {
            return {
              action: "replace",
              deleteFirst:
                news.clientVpnEndpointId === olds.clientVpnEndpointId,
            };
          }
          const network = yield* findNetwork(news, output?.associationId);
          if (network?.Status?.Code === "association-failed") {
            return { action: "replace", deleteFirst: true };
          }
          if (!network || network.Status?.Code !== "associated") {
            return {
              action: "update",
              stables: ["clientVpnEndpointId", "subnetId", "vpcId"],
            };
          }
        }),
        reconcile: Effect.fn(function* ({ news }) {
          let network = yield* findNetwork(news);
          if (network?.Status?.Code === "disassociating") {
            yield* waitForNetwork(news, network.AssociationId, true);
            network = undefined;
          }
          let associationId = network?.AssociationId;
          if (!network) {
            // Do not replay a completed create token after out-of-band deletion.
            const clientToken = yield* Effect.sync(() => crypto.randomUUID());
            const created = yield* ec2
              .associateClientVpnTargetNetwork({
                ClientVpnEndpointId: news.clientVpnEndpointId,
                SubnetId: news.subnetId,
                ClientToken: clientToken,
              })
              .pipe(
                Effect.catchTag(
                  [
                    "ClientVpnEndpointAssociationExists",
                    "InvalidClientVpnDuplicateAssociationException",
                  ],
                  () => Effect.succeed(undefined),
                ),
                (effect) =>
                  retryClientVpn(
                    effect,
                    (error) => error._tag === "IncorrectState",
                  ),
              );
            associationId = created?.AssociationId;
          }
          const associated = yield* waitForNetwork(news, associationId, false);
          if (!associated?.AssociationId) {
            return yield* new ClientVpnAssociationFailed({
              message:
                "AWS did not return a Client VPN target association identifier.",
            });
          }
          return toAttributes(news.clientVpnEndpointId, associated);
        }),
        delete: Effect.fn(function* ({ output }) {
          const network = yield* findNetwork(output, output.associationId);
          if (!network) return;
          if (network.Status?.Code !== "disassociating") {
            yield* ec2
              .disassociateClientVpnTargetNetwork({
                ClientVpnEndpointId: output.clientVpnEndpointId,
                AssociationId: output.associationId,
              })
              .pipe(
                Effect.catchTag(
                  [
                    "InvalidClientVpnEndpointId.NotFound",
                    "InvalidClientVpnAssociationIdNotFound",
                  ],
                  () => Effect.void,
                ),
                (effect) =>
                  retryClientVpn(
                    effect,
                    (error) => error._tag === "IncorrectState",
                  ),
              );
          }
          yield* waitForNetwork(output, output.associationId, true);
        }),
      };
    }),
  );

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

/** Immutable settings for a Client VPN ingress authorization rule. */
export interface ClientVpnAuthorizationRuleProps {
  /** The Client VPN endpoint. Changing this replaces the rule. */
  clientVpnEndpointId: ClientVpnEndpointId;
  /** The destination IPv4 CIDR to authorize. Changing this replaces the rule. */
  targetNetworkCidr: string;
  /**
   * The directory or federated identity group allowed to access the network.
   * Required unless authorizeAllGroups is true. Changing this replaces the rule.
   */
  accessGroupId?: string;
  /**
   * Authorize every authenticated client instead of one access group.
   * Cannot be combined with accessGroupId. Changing this replaces the rule.
   * @default false
   */
  authorizeAllGroups?: boolean;
  /** A description of the rule. Changing this replaces the rule. */
  description?: string;
}

/** An ingress authorization rule owned by a Client VPN endpoint. */
export interface ClientVpnAuthorizationRule extends Resource<
  "AWS.EC2.ClientVpnAuthorizationRule",
  ClientVpnAuthorizationRuleProps,
  {
    /** The Client VPN endpoint containing the rule. */
    clientVpnEndpointId: ClientVpnEndpointId;
    /** The canonical destination network CIDR. */
    targetNetworkCidr: string;
    /** The authorized group, absent for an all-groups rule. */
    accessGroupId: string | undefined;
    /** Whether all authenticated clients are authorized. */
    authorizeAllGroups: boolean;
    /** The observed description. */
    description: string | undefined;
    /** The current authorization state. */
    status: ec2.ClientVpnAuthorizationRuleStatusCode;
    /** Additional information about the authorization state. */
    statusMessage: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Authorizes Client VPN clients to access a destination network. Authorization
 * does not create a route: configure a target association and any required routes
 * separately. Specify either accessGroupId or authorizeAllGroups: true.
 *
 * Every property is immutable, including description. Description-only changes
 * revoke the old rule before creating its replacement. This resource manages the
 * declared endpoint/CIDR/group identity, including an existing rule discovered
 * without cached state. Rules have no independent ownership markers. Revoking an
 * all-groups rule leaves group-specific rules untouched.
 *
 * Readiness waits default to 30 minutes. Set `AWS_CLIENT_VPN_TIMEOUT` to a
 * positive finite duration, such as `45 minutes`, to override this deadline.
 *
 * ### Authorizing All Clients
 * **Example:** Permit authenticated clients to reach the VPC
 * ```typescript
 * const rule = yield* AWS.EC2.ClientVpnAuthorizationRule("VpnVpcAccess", {
 *   clientVpnEndpointId: endpoint.clientVpnEndpointId,
 *   targetNetworkCidr: "10.0.0.0/16",
 *   authorizeAllGroups: true,
 *   description: "Access to the VPC",
 * });
 * ```
 *
 * ### Authorizing One Group
 * **Example:** Restrict a destination to a directory group
 * ```typescript
 * const rule = yield* AWS.EC2.ClientVpnAuthorizationRule("VpnAdminAccess", {
 *   clientVpnEndpointId: endpoint.clientVpnEndpointId,
 *   targetNetworkCidr: "10.0.1.0/24",
 *   accessGroupId: "S-1-5-21-123456789-123456789-123456789-1234",
 * });
 * ```
 *
 * @resource
 */
export const ClientVpnAuthorizationRule = Resource<ClientVpnAuthorizationRule>(
  "AWS.EC2.ClientVpnAuthorizationRule",
);

class ClientVpnAuthorizationPending extends Data.TaggedError(
  "ClientVpnAuthorizationPending",
)<{ message: string }> {}

class ClientVpnAuthorizationFailed extends Data.TaggedError(
  "ClientVpnAuthorizationFailed",
)<{ message: string }> {}

const rules = (clientVpnEndpointId: ClientVpnEndpointId) =>
  ec2.describeClientVpnAuthorizationRules
    .items({ ClientVpnEndpointId: clientVpnEndpointId })
    .pipe(
      Stream.runCollect,
      Effect.map((items) =>
        items.filter((rule) => rule.Status?.Code !== "revoked"),
      ),
      Effect.catchTag("InvalidClientVpnEndpointId.NotFound", () =>
        Effect.succeed([] as ec2.AuthorizationRule[]),
      ),
    );

const findRule = (props: ClientVpnAuthorizationRuleProps) =>
  rules(props.clientVpnEndpointId).pipe(
    Effect.map((items) =>
      items.find(
        (rule) =>
          canonicalCidr(rule.DestinationCidr) ===
            canonicalCidr(props.targetNetworkCidr) &&
          (rule.AccessAll ?? false) === (props.authorizeAllGroups ?? false) &&
          (props.authorizeAllGroups === true ||
            rule.GroupId === props.accessGroupId),
      ),
    ),
  );

const toAttributes = (
  clientVpnEndpointId: ClientVpnEndpointId,
  rule: ec2.AuthorizationRule,
): ClientVpnAuthorizationRule["Attributes"] => ({
  clientVpnEndpointId,
  targetNetworkCidr: rule.DestinationCidr!,
  accessGroupId: rule.AccessAll ? undefined : rule.GroupId,
  authorizeAllGroups: rule.AccessAll ?? false,
  description: rule.Description,
  status: rule.Status?.Code ?? "authorizing",
  statusMessage: rule.Status?.Message,
});

const waitForRule = (
  props: ClientVpnAuthorizationRuleProps,
  deleted: boolean,
) =>
  Effect.gen(function* () {
    const rule = yield* findRule(props);
    if (deleted && !rule) return undefined;
    if (!deleted && rule?.Status?.Code === "active") return rule;
    if (!deleted && rule?.Status?.Code === "failed") {
      return yield* new ClientVpnAuthorizationFailed({
        message: rule.Status.Message ?? "Client VPN authorization failed",
      });
    }
    return yield* new ClientVpnAuthorizationPending({
      message: `Client VPN authorization for ${props.targetNetworkCidr} is ${rule?.Status?.Code ?? "not visible"}; waiting for ${deleted ? "revocation" : "active"}`,
    });
  }).pipe((effect) =>
    retryClientVpn(
      effect,
      (error) => error._tag === "ClientVpnAuthorizationPending",
    ),
  );

const removeRule = Effect.fn(function* (
  props: ClientVpnAuthorizationRuleProps,
) {
  const rule = yield* findRule(props);
  if (!rule) return;
  if (rule.Status?.Code !== "revoking") {
    yield* ec2
      .revokeClientVpnIngress({
        ClientVpnEndpointId: props.clientVpnEndpointId,
        TargetNetworkCidr: canonicalCidr(props.targetNetworkCidr),
        AccessGroupId: props.authorizeAllGroups
          ? undefined
          : props.accessGroupId,
        RevokeAllGroups: props.authorizeAllGroups ?? false,
      })
      .pipe(
        Effect.catchTag(
          [
            "InvalidClientVpnEndpointId.NotFound",
            "InvalidClientVpnEndpointAuthorizationRuleNotFound",
          ],
          () => Effect.void,
        ),
        (effect) =>
          retryClientVpn(effect, (error) => error._tag === "IncorrectState"),
      );
  }
  yield* waitForRule(props, true);
});

/** Live AWS provider for ClientVpnAuthorizationRule. */
export const ClientVpnAuthorizationRuleProvider = () =>
  Provider.effect(
    ClientVpnAuthorizationRule,
    Effect.gen(function* () {
      return {
        stables: [
          "clientVpnEndpointId",
          "targetNetworkCidr",
          "accessGroupId",
          "authorizeAllGroups",
        ],
        nuke: { dependsOn: ["AWS.EC2.ClientVpnEndpoint"] },
        list: Effect.fn(function* () {
          const endpoints = yield* ec2.describeClientVpnEndpoints
            .items({})
            .pipe(Stream.runCollect);
          const items = yield* Effect.forEach(endpoints, (endpoint) =>
            rules(endpoint.ClientVpnEndpointId as ClientVpnEndpointId).pipe(
              Effect.map((items) =>
                items.map((rule) =>
                  toAttributes(
                    endpoint.ClientVpnEndpointId as ClientVpnEndpointId,
                    rule,
                  ),
                ),
              ),
            ),
          );
          return items.flat();
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const props = output ?? olds;
          const rule = yield* findRule(props);
          if (!rule) return undefined;
          return toAttributes(props.clientVpnEndpointId, rule);
        }),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) {
            return { action: "replace", deleteFirst: true };
          }
          const sameKey =
            news.clientVpnEndpointId === olds.clientVpnEndpointId &&
            canonicalCidr(news.targetNetworkCidr) ===
              canonicalCidr(olds.targetNetworkCidr) &&
            news.accessGroupId === olds.accessGroupId &&
            (news.authorizeAllGroups ?? false) ===
              (olds.authorizeAllGroups ?? false);
          if (
            !sameKey ||
            news.targetNetworkCidr !== olds.targetNetworkCidr ||
            news.authorizeAllGroups !== olds.authorizeAllGroups ||
            news.description !== olds.description
          ) {
            return { action: "replace", deleteFirst: sameKey };
          }
          const rule = yield* findRule(news);
          if (!rule) return { action: "update" };
          if (
            (rule.Description ?? "") !== (news.description ?? "") ||
            rule.Status?.Code === "failed"
          ) {
            return { action: "replace", deleteFirst: true };
          }
          if (rule.Status?.Code !== "active") return { action: "update" };
        }),
        reconcile: Effect.fn(function* ({ news }) {
          if (
            (news.authorizeAllGroups === true) ===
              (news.accessGroupId !== undefined) ||
            news.accessGroupId === ""
          ) {
            return yield* new ClientVpnAuthorizationFailed({
              message:
                "Specify exactly one of accessGroupId or authorizeAllGroups: true.",
            });
          }
          let rule = yield* findRule(news);
          if (
            rule &&
            (rule.Status?.Code === "revoking" ||
              (rule.Description ?? "") !== (news.description ?? ""))
          ) {
            yield* removeRule(news);
            rule = undefined;
          }
          if (!rule) {
            // Do not replay a completed create token after out-of-band deletion.
            const clientToken = yield* Effect.sync(() => crypto.randomUUID());
            yield* ec2
              .authorizeClientVpnIngress({
                ClientVpnEndpointId: news.clientVpnEndpointId,
                TargetNetworkCidr: canonicalCidr(news.targetNetworkCidr),
                AccessGroupId: news.accessGroupId,
                AuthorizeAllGroups: news.authorizeAllGroups ?? false,
                Description: news.description,
                ClientToken: clientToken,
              })
              .pipe(
                Effect.catchTag(
                  "InvalidClientVpnDuplicateAuthorizationRule",
                  () => Effect.void,
                ),
                (effect) =>
                  retryClientVpn(
                    effect,
                    (error) => error._tag === "IncorrectState",
                  ),
              );
          }
          const active = yield* waitForRule(news, false);
          return toAttributes(news.clientVpnEndpointId, active!);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* removeRule(output);
        }),
      };
    }),
  );

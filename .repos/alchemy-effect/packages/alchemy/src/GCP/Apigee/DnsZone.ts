import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  createOwnership,
  defaultOrgName,
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  letterPrefixedId,
  listOrgNames,
  orgIdOf,
  orgNameOf,
  ownedBy,
  parseDescription,
  waitForOperation,
} from "./operations.ts";

export type DnsZonePeeringConfig = {
  /** VPC network whose private DNS namespace Apigee peers with. */
  targetNetworkId: string;
  /** Project id that contains `targetNetworkId`. */
  targetProjectId: string;
};

export type DnsZoneProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the zone.
   */
  organization?: string;
  /**
   * DNS zone id (the `{dns_zone}` segment of
   * `organizations/{org}/dnsZones/{dns_zone}`). Must be 1-63 characters,
   * begin with a letter, end with a letter or digit, and contain only
   * lowercase letters, digits, or dashes. If omitted, a unique name is
   * generated. Immutable — changing it replaces the zone.
   */
  dnsZoneId?: string;
  /**
   * Domain name for hosts in this private zone (for example
   * `example.com.`). Immutable — changing it replaces the zone.
   */
  domain: string;
  /**
   * DNS peering configuration. Immutable — changing it replaces the zone.
   */
  peeringConfig: DnsZonePeeringConfig;
  /**
   * Human-readable description (required by Apigee, max 1024 characters).
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type DnsZone = Resource<
  "GCP.Apigee.DnsZone",
  DnsZoneProps,
  {
    /** Full resource name `organizations/{org}/dnsZones/{dns_zone}`. */
    name: string;
    /** DNS zone id (last path segment). */
    dnsZoneId: string;
    /** Apigee organization id. */
    organization: string;
    /** Peered domain. */
    domain: string;
    /** DNS peering configuration. */
    peeringConfig: DnsZonePeeringConfig | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported state (`CREATING`, `ACTIVE`, …). */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee DNS peering zone that lets runtime instances resolve hostnames
 * in a peered VPC.
 *
 * Apigee DNS zones have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. Name, domain, and peering config are
 * identity — changing them replaces the zone. Description updates in place
 * only if the API later exposes a patch; today the resource is
 * existence-only besides identity.
 *
 * ### Creating a DNS Zone
 * **Example:** Peer with the default VPC
 * ```typescript
 * const zone = yield* GCP.Apigee.DnsZone("PrivateDns", {
 *   domain: "internal.example.com.",
 *   peeringConfig: {
 *     targetNetworkId: "default",
 *     targetProjectId: "my-project",
 *   },
 *   description: "runtime DNS peering",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const DnsZone = Resource<DnsZone>("GCP.Apigee.DnsZone");

/** Alias matching the catalog name `Dn`. */
export const Dn = DnsZone;

export class DnsZoneNotResolved extends Data.TaggedError(
  "GCP.Apigee.DnsZoneNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organization: string, dnsZoneId: string) =>
  `${orgNameOf(organization)}/dnsZones/${dnsZoneId}`;

const toAttrs = (
  zone: apigee.GoogleCloudApigeeV1DnsZone,
  organization: string,
) => {
  const name = zone.name ?? "";
  const parsed = parseDescription(zone.description);
  const peering = zone.peeringConfig;
  return {
    name,
    dnsZoneId: lastSegment(name),
    organization: orgIdOf(organization),
    domain: zone.domain ?? "",
    peeringConfig:
      peering?.targetNetworkId !== undefined ||
      peering?.targetProjectId !== undefined
        ? {
            targetNetworkId: peering.targetNetworkId ?? "",
            targetProjectId: peering.targetProjectId ?? "",
          }
        : undefined,
    description: parsed.description,
    state: zone.state,
    createTime: zone.createTime,
    updateTime: zone.updateTime,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsDnsZones({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const DnsZoneProvider = () =>
  Provider.succeed(DnsZone, {
    stables: ["name", "dnsZoneId", "organization", "domain", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.dnsZoneId ?? output?.dnsZoneId;
      const previousOrg = olds?.organization ?? output?.organization;
      const previousDomain = olds?.domain ?? output?.domain;
      const previousPeer = olds?.peeringConfig ?? output?.peeringConfig;
      const idChanged =
        previousId !== undefined &&
        news.dnsZoneId !== undefined &&
        news.dnsZoneId !== previousId;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        orgIdOf(news.organization) !== orgIdOf(previousOrg);
      const domainChanged =
        previousDomain !== undefined && news.domain !== previousDomain;
      const peerChanged =
        previousPeer !== undefined &&
        (previousPeer.targetNetworkId !== news.peeringConfig.targetNetworkId ||
          previousPeer.targetProjectId !== news.peeringConfig.targetProjectId);
      if (idChanged || orgChanged || domainChanged || peerChanged) {
        return {
          action: "replace" as const,
          deleteFirst: idChanged && !orgChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(
        env.project,
        olds?.organization ?? output?.organization,
      );
      const dnsZoneId = yield* letterPrefixedId(
        id,
        olds?.dnsZoneId,
        output?.dnsZoneId,
        63,
      );
      const name = output?.name ?? resourceName(organization, dnsZoneId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedBy(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const orgs = yield* listOrgNames();
        const rows: DnsZone["Attributes"][] = [];
        for (const organization of orgs) {
          const zones = yield* collectPages(
            apigee.listOrganizationsDnsZones.pages({
              parent: organization,
              pageSize: 1000,
            }),
            (page) => page.dnsZones,
          ).pipe(
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed([] as apigee.GoogleCloudApigeeV1DnsZone[]),
            ),
          );
          for (const zone of zones) {
            if (hasOwnershipMarker(zone.description)) {
              rows.push(toAttrs(zone, organization));
            }
          }
        }
        return rows;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(env.project, news.organization);
      const dnsZoneId = yield* letterPrefixedId(
        id,
        news.dnsZoneId,
        output?.dnsZoneId,
        63,
      );
      const name = resourceName(organization, dnsZoneId);
      const ownership = yield* createOwnership(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const operation = yield* apigee
          .createOrganizationsDnsZones({
            parent: organization,
            dnsZoneId,
            body: {
              description: desiredDescription,
              domain: news.domain,
              peeringConfig: news.peeringConfig,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (operation !== undefined) {
          yield* waitForOperation(operation);
        }
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new DnsZoneNotResolved({ name });
      }

      return toAttrs(current, organization);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apigee
        .deleteOrganizationsDnsZones({ name: output.name })
        .pipe(
          Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });

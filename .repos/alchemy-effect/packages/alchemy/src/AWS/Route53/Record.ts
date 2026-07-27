import * as route53 from "@distilled.cloud/aws/route-53";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { durationToSeconds } from "../IAM/common.ts";
import type { Providers } from "../Providers.ts";

export interface RecordAliasTarget {
  /**
   * Hosted zone ID for the alias target.
   */
  hostedZoneId: Input<string>;
  /**
   * DNS name for the alias target.
   */
  dnsName: Input<string>;
  /**
   * Whether Route 53 should evaluate target health for the alias.
   * @default false
   */
  evaluateTargetHealth?: boolean;
}

/**
 * Fully-resolved alias target as stored in the record's attributes — a
 * `RecordAliasTarget` with all `Input` values resolved.
 */
export interface ResolvedRecordAliasTarget {
  /**
   * Hosted zone ID for the alias target.
   */
  hostedZoneId: string;
  /**
   * DNS name for the alias target.
   */
  dnsName: string;
  /**
   * Whether Route 53 evaluates target health for the alias.
   * @default false
   */
  evaluateTargetHealth?: boolean;
}

export interface RecordGeoLocation {
  /**
   * Two-letter continent code (e.g. `"NA"`, `"EU"`). Mutually exclusive with
   * `countryCode`.
   */
  continentCode?: string;
  /**
   * Two-letter country code, or `"*"` for the default (catch-all) record.
   */
  countryCode?: string;
  /**
   * Subdivision code (e.g. a US state). Requires `countryCode`.
   */
  subdivisionCode?: string;
}

export interface RecordGeoProximityCoordinates {
  /** Latitude as a string (e.g. `"49.22"`). */
  latitude: string;
  /** Longitude as a string (e.g. `"-122.41"`). */
  longitude: string;
}

export interface RecordGeoProximityLocation {
  /** AWS Region for the endpoint. Mutually exclusive with `coordinates`. */
  awsRegion?: string;
  /** Local Zone Group for the endpoint. */
  localZoneGroup?: string;
  /** Explicit latitude/longitude of the endpoint. */
  coordinates?: RecordGeoProximityCoordinates;
  /** Bias (-99 to 99) that expands or shrinks the geographic region. */
  bias?: number;
}

export interface RecordCidrRoutingConfig {
  /** ID of the CIDR collection. */
  collectionId: string;
  /** Name of the CIDR location within the collection. */
  locationName: string;
}

export interface RecordProps {
  /**
   * Hosted zone that owns the record.
   */
  hostedZoneId: string;
  /**
   * Record name.
   */
  name: string;
  /**
   * Record type.
   */
  type: route53.RRType;
  /**
   * TTL for non-alias records, e.g. `"60 seconds"` or `Duration.minutes(5)`
   * (a bare number is milliseconds). Rounded to whole seconds on the wire.
   */
  ttl?: Duration.Input;
  /**
   * Record values for non-alias records.
   */
  records?: string[];
  /**
   * Alias target for alias records.
   */
  aliasTarget?: RecordAliasTarget;
  /**
   * Optional set identifier for weighted, latency, failover, and other routing
   * policies that require unique record identities.
   */
  setIdentifier?: string;
  /**
   * Weight (0-255) for weighted routing. Requires `setIdentifier`.
   */
  weight?: number;
  /**
   * AWS Region for latency-based routing. Requires `setIdentifier`.
   */
  region?: route53.ResourceRecordSetRegion;
  /**
   * Failover role for failover routing. Requires `setIdentifier`.
   */
  failover?: "PRIMARY" | "SECONDARY";
  /**
   * Geolocation routing rule. Requires `setIdentifier`.
   */
  geoLocation?: RecordGeoLocation;
  /**
   * Geoproximity routing rule. Requires `setIdentifier`.
   */
  geoProximityLocation?: RecordGeoProximityLocation;
  /**
   * Whether this record participates in multivalue answer routing. Requires
   * `setIdentifier`.
   */
  multiValueAnswer?: boolean;
  /**
   * IP-based (CIDR) routing rule. Requires `setIdentifier`.
   */
  cidrRoutingConfig?: RecordCidrRoutingConfig;
  /**
   * Health check that gates whether Route 53 returns this record. Typically a
   * `HealthCheck.id`.
   */
  healthCheckId?: string;
}

export interface Record extends Resource<
  "AWS.Route53.Record",
  RecordProps,
  {
    /**
     * Hosted zone that owns the record.
     */
    hostedZoneId: string;
    /**
     * Fully qualified record name.
     */
    name: string;
    /**
     * Record type.
     */
    type: route53.RRType;
    /**
     * Current TTL for non-alias records.
     */
    ttl: number | undefined;
    /**
     * Current non-alias record values.
     */
    records: string[] | undefined;
    /**
     * Current alias target, when this record is an alias.
     */
    aliasTarget: ResolvedRecordAliasTarget | undefined;
    /**
     * Optional routing set identifier.
     */
    setIdentifier: string | undefined;
    /**
     * Weight for weighted routing.
     */
    weight: number | undefined;
    /**
     * AWS Region for latency routing.
     */
    region: route53.ResourceRecordSetRegion | undefined;
    /**
     * Failover role for failover routing.
     */
    failover: "PRIMARY" | "SECONDARY" | undefined;
    /**
     * Geolocation routing rule.
     */
    geoLocation: RecordGeoLocation | undefined;
    /**
     * Geoproximity routing rule.
     */
    geoProximityLocation: RecordGeoProximityLocation | undefined;
    /**
     * Whether this record participates in multivalue answer routing.
     */
    multiValueAnswer: boolean | undefined;
    /**
     * IP-based (CIDR) routing rule.
     */
    cidrRoutingConfig: RecordCidrRoutingConfig | undefined;
    /**
     * Health check that gates this record.
     */
    healthCheckId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Route 53 DNS record set.
 *
 * `Record` manages a single Route 53 record set using `UPSERT` for create and
 * update operations, and waits for Route 53 change propagation before
 * returning.
 * @resource
 * @section Creating Records
 * @example A Record Alias To CloudFront
 * ```typescript
 * const record = yield* Record("WebsiteAlias", {
 *   hostedZoneId: "Z1234567890",
 *   name: "www.example.com",
 *   type: "A",
 *   aliasTarget: {
 *     hostedZoneId: distribution.hostedZoneId,
 *     dnsName: distribution.domainName,
 *   },
 * });
 * ```
 *
 * @example TXT Record
 * ```typescript
 * const record = yield* Record("VerificationRecord", {
 *   hostedZoneId: "Z1234567890",
 *   name: "_acme-challenge.example.com",
 *   type: "TXT",
 *   ttl: "60 seconds",
 *   records: ["\"value\""],
 * });
 * ```
 *
 * @section Routing Policies
 * @example Weighted Routing
 * ```typescript
 * const blue = yield* Record("Blue", {
 *   hostedZoneId: zone.id,
 *   name: "api.example.com",
 *   type: "A",
 *   ttl: "60 seconds",
 *   records: ["1.2.3.4"],
 *   setIdentifier: "blue",
 *   weight: 90,
 * });
 * const green = yield* Record("Green", {
 *   hostedZoneId: zone.id,
 *   name: "api.example.com",
 *   type: "A",
 *   ttl: "60 seconds",
 *   records: ["5.6.7.8"],
 *   setIdentifier: "green",
 *   weight: 10,
 * });
 * ```
 *
 * @example Failover Routing With Health Check
 * ```typescript
 * const primary = yield* Record("Primary", {
 *   hostedZoneId: zone.id,
 *   name: "app.example.com",
 *   type: "A",
 *   ttl: "60 seconds",
 *   records: ["1.2.3.4"],
 *   setIdentifier: "primary",
 *   failover: "PRIMARY",
 *   healthCheckId: healthCheck.id,
 * });
 * const secondary = yield* Record("Secondary", {
 *   hostedZoneId: zone.id,
 *   name: "app.example.com",
 *   type: "A",
 *   ttl: "60 seconds",
 *   records: ["5.6.7.8"],
 *   setIdentifier: "secondary",
 *   failover: "SECONDARY",
 * });
 * ```
 *
 * @example Latency Routing
 * ```typescript
 * const record = yield* Record("UsEast", {
 *   hostedZoneId: zone.id,
 *   name: "api.example.com",
 *   type: "A",
 *   ttl: "60 seconds",
 *   records: ["1.2.3.4"],
 *   setIdentifier: "us-east-1",
 *   region: "us-east-1",
 * });
 * ```
 *
 * @example Geolocation Routing
 * ```typescript
 * const record = yield* Record("Default", {
 *   hostedZoneId: zone.id,
 *   name: "www.example.com",
 *   type: "A",
 *   ttl: "60 seconds",
 *   records: ["1.2.3.4"],
 *   setIdentifier: "default",
 *   geoLocation: { countryCode: "*" },
 * });
 * ```
 */
export const Record = Resource<Record>("AWS.Route53.Record");

const normalizeHostedZoneId = (hostedZoneId: string) =>
  hostedZoneId.replace(/^\/hostedzone\//, "");

const normalizeName = (name: string) =>
  name.endsWith(".") ? name : `${name}.`;

const toAliasTarget = (
  aliasTarget: route53.AliasTarget | undefined,
): ResolvedRecordAliasTarget | undefined =>
  aliasTarget
    ? {
        hostedZoneId: aliasTarget.HostedZoneId,
        dnsName: aliasTarget.DNSName,
        evaluateTargetHealth: aliasTarget.EvaluateTargetHealth,
      }
    : undefined;

const toGeoLocation = (
  geo: RecordGeoLocation | undefined,
): route53.GeoLocation | undefined =>
  geo
    ? {
        ContinentCode: geo.continentCode,
        CountryCode: geo.countryCode,
        SubdivisionCode: geo.subdivisionCode,
      }
    : undefined;

const fromGeoLocation = (
  geo: route53.GeoLocation | undefined,
): RecordGeoLocation | undefined =>
  geo
    ? {
        continentCode: geo.ContinentCode,
        countryCode: geo.CountryCode,
        subdivisionCode: geo.SubdivisionCode,
      }
    : undefined;

const toGeoProximity = (
  geo: RecordGeoProximityLocation | undefined,
): route53.GeoProximityLocation | undefined =>
  geo
    ? {
        AWSRegion: geo.awsRegion,
        LocalZoneGroup: geo.localZoneGroup,
        Coordinates: geo.coordinates
          ? {
              Latitude: geo.coordinates.latitude,
              Longitude: geo.coordinates.longitude,
            }
          : undefined,
        Bias: geo.bias,
      }
    : undefined;

const fromGeoProximity = (
  geo: route53.GeoProximityLocation | undefined,
): RecordGeoProximityLocation | undefined =>
  geo
    ? {
        awsRegion: geo.AWSRegion,
        localZoneGroup: geo.LocalZoneGroup,
        coordinates: geo.Coordinates
          ? {
              latitude: geo.Coordinates.Latitude,
              longitude: geo.Coordinates.Longitude,
            }
          : undefined,
        bias: geo.Bias,
      }
    : undefined;

const toCidrRouting = (
  cidr: RecordCidrRoutingConfig | undefined,
): route53.CidrRoutingConfig | undefined =>
  cidr
    ? { CollectionId: cidr.collectionId, LocationName: cidr.locationName }
    : undefined;

const fromCidrRouting = (
  cidr: route53.CidrRoutingConfig | undefined,
): RecordCidrRoutingConfig | undefined =>
  cidr
    ? { collectionId: cidr.CollectionId, locationName: cidr.LocationName }
    : undefined;

/**
 * Build the full `ResourceRecordSet` wire shape from props. Used for both the
 * UPSERT change batch and the DELETE change batch — DELETE requires an exact
 * match of every policy field, so this must round-trip the entire surface.
 */
const toRecordSet = (
  props: Pick<
    RecordProps,
    | "name"
    | "type"
    | "records"
    | "aliasTarget"
    | "setIdentifier"
    | "weight"
    | "region"
    | "failover"
    | "geoLocation"
    | "geoProximityLocation"
    | "multiValueAnswer"
    | "cidrRoutingConfig"
    | "healthCheckId"
  > & {
    /** TTL already converted to wire seconds. */
    ttl?: number;
  },
): route53.ResourceRecordSet => ({
  Name: normalizeName(props.name),
  Type: props.type,
  SetIdentifier: props.setIdentifier,
  Weight: props.weight,
  Region: props.region,
  Failover: props.failover,
  GeoLocation: toGeoLocation(props.geoLocation),
  GeoProximityLocation: toGeoProximity(props.geoProximityLocation),
  MultiValueAnswer: props.multiValueAnswer,
  CidrRoutingConfig: toCidrRouting(props.cidrRoutingConfig),
  HealthCheckId: props.healthCheckId,
  TTL: props.aliasTarget ? undefined : props.ttl,
  ResourceRecords: props.aliasTarget
    ? undefined
    : (props.records ?? []).map((Value) => ({ Value })),
  AliasTarget: props.aliasTarget
    ? {
        HostedZoneId: normalizeHostedZoneId(
          props.aliasTarget.hostedZoneId as string,
        ),
        DNSName: props.aliasTarget.dnsName as string,
        EvaluateTargetHealth: props.aliasTarget.evaluateTargetHealth ?? false,
      }
    : undefined,
});

const toAttrs = (
  recordSet: route53.ResourceRecordSet,
  hostedZoneId: string,
) => ({
  hostedZoneId: normalizeHostedZoneId(hostedZoneId),
  name: recordSet.Name,
  type: recordSet.Type,
  ttl: recordSet.TTL,
  records: recordSet.ResourceRecords?.map((record) => record.Value),
  aliasTarget: toAliasTarget(recordSet.AliasTarget),
  setIdentifier: recordSet.SetIdentifier,
  weight: recordSet.Weight,
  region: recordSet.Region,
  failover: recordSet.Failover as "PRIMARY" | "SECONDARY" | undefined,
  geoLocation: fromGeoLocation(recordSet.GeoLocation),
  geoProximityLocation: fromGeoProximity(recordSet.GeoProximityLocation),
  multiValueAnswer: recordSet.MultiValueAnswer,
  cidrRoutingConfig: fromCidrRouting(recordSet.CidrRoutingConfig),
  healthCheckId: recordSet.HealthCheckId,
});

export const RecordProvider = () =>
  Provider.effect(
    Record,
    Effect.gen(function* () {
      // Poll `getChange` until the change reaches INSYNC. `getChange` is
      // eventually consistent and can briefly return `NoSuchChange` right after
      // submit, so coalesce that to a non-INSYNC status and keep polling.
      // `ChangeInfo.Id` comes back as "/change/C..." but `getChange` only
      // accepts the bare id — the prefixed form returns `NoSuchChange`
      // forever, silently burning the full repeat cap on every change.
      const waitForChange = Effect.fn(function* (changeId: string) {
        return yield* route53
          .getChange({ Id: changeId.replace(/^\/change\//, "") })
          .pipe(
            Effect.map((response) => response.ChangeInfo.Status),
            Effect.catchTag("NoSuchChange", () => Effect.succeed("PENDING")),
            Effect.repeat({
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(60),
              ]),
              until: (status) => status === "INSYNC",
            }),
          );
      });

      const findRecord = Effect.fn(function* (
        hostedZoneId: string,
        props: Pick<RecordProps, "name" | "type" | "setIdentifier">,
      ) {
        const response = yield* route53
          .listResourceRecordSets({
            HostedZoneId: normalizeHostedZoneId(hostedZoneId),
            StartRecordName: normalizeName(props.name),
            StartRecordType: props.type,
            MaxItems: 100,
          })
          .pipe(
            Effect.catchTag("NoSuchHostedZone", () =>
              Effect.succeed(undefined),
            ),
          );

        return (response?.ResourceRecordSets ?? []).find(
          (recordSet) =>
            recordSet.Name === normalizeName(props.name) &&
            recordSet.Type === props.type &&
            (recordSet.SetIdentifier ?? undefined) === props.setIdentifier,
        );
      });

      const upsertRecord = Effect.fn(function* (props: RecordProps) {
        const response = yield* route53.changeResourceRecordSets({
          HostedZoneId: normalizeHostedZoneId(props.hostedZoneId),
          ChangeBatch: {
            Comment: "Alchemy Route53 record upsert",
            Changes: [
              {
                Action: "UPSERT",
                ResourceRecordSet: toRecordSet({
                  ...props,
                  ttl: durationToSeconds(props.ttl),
                }),
              },
            ],
          },
        });

        yield* waitForChange(response.ChangeInfo.Id);
      });

      // `listResourceRecordSets` is not paginated by distilled, so manually
      // walk the `IsTruncated` / `NextRecord*` cursor to collect every record
      // set in a hosted zone.
      const listAllRecordSets = Effect.fn(function* (hostedZoneId: string) {
        const all: route53.ResourceRecordSet[] = [];
        let request: route53.ListResourceRecordSetsRequest = {
          HostedZoneId: normalizeHostedZoneId(hostedZoneId),
          MaxItems: 300,
        };
        while (true) {
          const response = yield* route53.listResourceRecordSets(request);
          all.push(...(response.ResourceRecordSets ?? []));
          if (!response.IsTruncated || response.NextRecordName === undefined) {
            break;
          }
          request = {
            HostedZoneId: normalizeHostedZoneId(hostedZoneId),
            StartRecordName: response.NextRecordName,
            StartRecordType: response.NextRecordType,
            StartRecordIdentifier: response.NextRecordIdentifier,
            MaxItems: 300,
          };
        }
        return all;
      });

      return {
        stables: ["hostedZoneId", "name", "type", "setIdentifier"],
        list: () =>
          Effect.gen(function* () {
            // Records are hosted-zone-scoped: enumerate every hosted zone
            // (paginated), then fan out one `listResourceRecordSets` walk per
            // zone with bounded concurrency.
            const zones = yield* route53.listHostedZones.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.HostedZones ?? []),
              ),
            );

            const rows = yield* Effect.forEach(
              zones,
              (zone) =>
                listAllRecordSets(zone.Id).pipe(
                  Effect.map((recordSets) =>
                    recordSets.map((recordSet) => toAttrs(recordSet, zone.Id)),
                  ),
                  // A zone may be deleted concurrently with enumeration; treat
                  // a vanished zone as contributing no records.
                  Effect.catchTag("NoSuchHostedZone", () => Effect.succeed([])),
                ),
              { concurrency: 10 },
            );

            return rows.flat();
          }),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // Identity change → replace, but only when the old value is known —
          // a half-created state row can't round-trip Output-valued props
          // (they deserialize as `undefined`), and an unknown old identity
          // must fall through to the create/update recovery path.
          if (
            (olds.hostedZoneId !== undefined &&
              normalizeHostedZoneId(olds.hostedZoneId) !==
                normalizeHostedZoneId(news.hostedZoneId)) ||
            (olds.name !== undefined &&
              normalizeName(olds.name) !== normalizeName(news.name)) ||
            olds.type !== news.type ||
            olds.setIdentifier !== news.setIdentifier
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const hostedZoneId = output?.hostedZoneId ?? olds?.hostedZoneId;
          const name = output?.name ?? olds?.name;
          const type = output?.type ?? olds?.type;
          if (
            hostedZoneId === undefined ||
            name === undefined ||
            type === undefined
          ) {
            // Output-valued props don't survive a `creating`-state round-trip
            // — without the record's identity we can't look it up. Report
            // "not found" so the engine re-drives the create (the UPSERT in
            // reconcile converges on any half-created record).
            return undefined;
          }
          const recordSet = yield* findRecord(hostedZoneId, {
            name,
            type,
            setIdentifier: output?.setIdentifier ?? olds?.setIdentifier,
          });

          if (!recordSet) {
            return undefined;
          }

          return toAttrs(recordSet, hostedZoneId);
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          // Route 53 `changeResourceRecordSets` with `UPSERT` is naturally
          // reconciler-friendly: it creates the record if missing and
          // overwrites it if present. There's no separate ensure/sync split
          // — one call converges to the desired record set.
          yield* upsertRecord(news);

          // Re-read so the returned attributes reflect the actual current
          // record (including server-applied defaults).
          const recordSet = yield* findRecord(news.hostedZoneId, news);

          if (!recordSet) {
            return yield* Effect.die(
              new Error("Route53 record was not found after upsert"),
            );
          }

          yield* session.note(`${news.type} ${normalizeName(news.name)}`);
          return toAttrs(recordSet, news.hostedZoneId);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* route53
            .changeResourceRecordSets({
              HostedZoneId: normalizeHostedZoneId(output.hostedZoneId),
              ChangeBatch: {
                Comment: "Alchemy Route53 record delete",
                Changes: [
                  {
                    Action: "DELETE",
                    // Serialize the full record set — DELETE requires an exact
                    // match including routing-policy fields, so reuse the same
                    // builder as UPSERT against the stored attributes.
                    ResourceRecordSet: toRecordSet({
                      name: output.name,
                      type: output.type,
                      ttl: output.ttl,
                      records: output.records,
                      aliasTarget: output.aliasTarget,
                      setIdentifier: output.setIdentifier,
                      weight: output.weight,
                      region: output.region,
                      failover: output.failover,
                      geoLocation: output.geoLocation,
                      geoProximityLocation: output.geoProximityLocation,
                      multiValueAnswer: output.multiValueAnswer,
                      cidrRoutingConfig: output.cidrRoutingConfig,
                      healthCheckId: output.healthCheckId,
                    }),
                  },
                ],
              },
            })
            .pipe(
              Effect.flatMap((response) =>
                waitForChange(response.ChangeInfo.Id),
              ),
              Effect.catchTag("NoSuchHostedZone", () => Effect.void),
              Effect.catchTag("InvalidChangeBatch", () => Effect.void),
            );
        }),
      };
    }),
  );

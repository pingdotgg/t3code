import * as route53 from "@distilled.cloud/aws/route-53";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
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

export interface ResolvedRecordAliasTarget {
  hostedZoneId: string;
  dnsName: string;
  evaluateTargetHealth?: boolean;
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
   * TTL in seconds for non-alias records.
   */
  ttl?: number;
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
 *
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
 *   ttl: 60,
 *   records: ["\"value\""],
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

const toRecordSet = (props: RecordProps): route53.ResourceRecordSet => ({
  Name: normalizeName(props.name),
  Type: props.type,
  SetIdentifier: props.setIdentifier,
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
});

export const RecordProvider = () =>
  Provider.effect(
    Record,
    Effect.gen(function* () {
      const waitForChange = Effect.fn(function* (changeId: string) {
        return yield* route53.getChange({ Id: changeId }).pipe(
          Effect.map((response) => response.ChangeInfo),
          Effect.flatMap((changeInfo) =>
            changeInfo.Status === "INSYNC"
              ? Effect.succeed(changeInfo)
              : Effect.die(new Error("Route53ChangePending")),
          ),
          Effect.retry({
            while: (error) =>
              error instanceof Error &&
              error.message === "Route53ChangePending",
            schedule: Schedule.fixed("2 seconds").pipe(
              Schedule.both(Schedule.recurs(60)),
            ),
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

        return response?.ResourceRecordSets.find(
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
                ResourceRecordSet: toRecordSet(props),
              },
            ],
          },
        });

        yield* waitForChange(response.ChangeInfo.Id);
      });

      return {
        stables: ["hostedZoneId", "name", "type", "setIdentifier"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            normalizeHostedZoneId(olds.hostedZoneId) !==
              normalizeHostedZoneId(news.hostedZoneId) ||
            normalizeName(olds.name) !== normalizeName(news.name) ||
            olds.type !== news.type ||
            olds.setIdentifier !== news.setIdentifier
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const recordSet = yield* findRecord(
            output?.hostedZoneId ?? olds!.hostedZoneId,
            {
              name: output?.name ?? olds!.name,
              type: output?.type ?? olds!.type,
              setIdentifier: output?.setIdentifier ?? olds!.setIdentifier,
            },
          );

          if (!recordSet) {
            return undefined;
          }

          return toAttrs(recordSet, output?.hostedZoneId ?? olds!.hostedZoneId);
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
                    ResourceRecordSet: {
                      Name: output.name,
                      Type: output.type,
                      SetIdentifier: output.setIdentifier,
                      TTL: output.aliasTarget ? undefined : output.ttl,
                      ResourceRecords: output.records?.map((Value) => ({
                        Value,
                      })),
                      AliasTarget: output.aliasTarget
                        ? {
                            HostedZoneId: normalizeHostedZoneId(
                              output.aliasTarget.hostedZoneId as string,
                            ),
                            DNSName: output.aliasTarget.dnsName as string,
                            EvaluateTargetHealth:
                              output.aliasTarget.evaluateTargetHealth ?? false,
                          }
                        : undefined,
                    },
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

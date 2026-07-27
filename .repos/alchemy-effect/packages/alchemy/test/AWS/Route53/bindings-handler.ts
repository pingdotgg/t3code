import * as Lambda from "@/AWS/Lambda";
import * as Route53 from "@/AWS/Route53";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

// Deterministic probe record written and deleted by /record/roundtrip.
const PROBE_LABEL = "probe";
const PROBE_VALUE = '"alchemy-route53-bindings"';

export class Route53BindingsFunction extends Lambda.Function<Lambda.Function>()(
  "Route53BindingsFunction",
) {}

export default Route53BindingsFunction.make(
  {
    main,
    url: true,
    // /record/roundtrip polls GetChange until INSYNC (typically ~20-60s).
    timeout: Duration.minutes(3),
  },
  Effect.gen(function* () {
    // Public zone under the reserved-domain-safe `.alchemy` TLD — never
    // delegated, but Route 53's authoritative servers (and TestDNSAnswer)
    // answer for it regardless.
    const zone = yield* Route53.HostedZone("BindingsZone", {
      name: "alchemy-route53-bindings.alchemy.",
      comment: "alchemy Route53 bindings fixture",
      forceDestroy: true,
    });

    const check = yield* Route53.HealthCheck("BindingsCheck", {
      type: "HTTP",
      fullyQualifiedDomainName: "example.com",
      resourcePath: "/",
      port: 80,
      requestInterval: "30 seconds",
      failureThreshold: 3,
    });

    const changeRecordSets = yield* Route53.ChangeResourceRecordSets(zone);
    const listRecordSets = yield* Route53.ListResourceRecordSets(zone);
    const getHostedZone = yield* Route53.GetHostedZone(zone);
    const testDnsAnswer = yield* Route53.TestDNSAnswer(zone);
    const getChange = yield* Route53.GetChange();
    const getHealthCheckStatus = yield* Route53.GetHealthCheckStatus(check);
    const getHealthCheckLastFailureReason =
      yield* Route53.GetHealthCheckLastFailureReason(check);
    const listHostedZones = yield* Route53.ListHostedZones();
    const listHostedZonesByName = yield* Route53.ListHostedZonesByName();
    const listHostedZonesByVpc = yield* Route53.ListHostedZonesByVPC();

    const bound = {
      changeRecordSets,
      listRecordSets,
      getHostedZone,
      testDnsAnswer,
      getChange,
      getHealthCheckStatus,
      getHealthCheckLastFailureReason,
      listHostedZones,
      listHostedZonesByName,
      listHostedZonesByVpc,
    };

    // `ChangeInfo.Id` comes back as "/change/C…" but GetChange only accepts
    // the bare id. Bounded: 2s x 40 ≈ 80s worst case.
    const waitForInsync = (changeId: string) =>
      getChange({ Id: changeId.replace(/^\/change\//, "") }).pipe(
        Effect.map((r) => r.ChangeInfo.Status),
        Effect.repeat({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(40),
          ]),
          until: (status): boolean => status === "INSYNC",
        }),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/zone") {
          // `Id` injection scopes the read to the bound zone.
          const detail = yield* getHostedZone();
          return yield* HttpServerResponse.json({
            name: detail.HostedZone.Name,
            nameServerCount: (detail.DelegationSet?.NameServers ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/zones") {
          const detail = yield* getHostedZone();
          const response = yield* listHostedZones({ MaxItems: 100 });
          return yield* HttpServerResponse.json({
            count: (response.HostedZones ?? []).length,
            found: (response.HostedZones ?? []).some(
              (z) => z.Id === detail.HostedZone.Id,
            ),
          });
        }

        if (request.method === "GET" && pathname === "/zones/by-name") {
          const detail = yield* getHostedZone();
          const response = yield* listHostedZonesByName({
            DNSName: detail.HostedZone.Name,
            MaxItems: 1,
          });
          return yield* HttpServerResponse.json({
            firstName: response.HostedZones?.[0]?.Name,
          });
        }

        if (request.method === "GET" && pathname === "/zones/by-vpc") {
          // A well-formed VPC id with no private-zone associations — the
          // call round-trips (IAM + query encoding) and returns an empty
          // summary list.
          const region = yield* Effect.sync(
            () => process.env.AWS_REGION ?? "us-east-1",
          );
          const response = yield* listHostedZonesByVpc({
            VPCId: "vpc-0123456789abcdef0",
            VPCRegion: region,
          }).pipe(
            Effect.map((r) => ({
              count: (r.HostedZoneSummaries ?? []).length,
              rejected: false,
              notOwned: false,
            })),
            // Route 53 validates VPC ownership before listing: a VPC id the
            // account doesn't own comes back as the typed AccessDeniedException
            // ("The VPC ... is not owned by you"), NOT an empty list. That
            // rejection still proves the grant + query encoding end-to-end —
            // but only when the message is the ownership check. A genuine IAM
            // denial ("not authorized to perform") sets notOwned=false and the
            // test fails loudly instead of being masked.
            Effect.catchTag(["InvalidInput", "AccessDeniedException"], (e) =>
              Effect.succeed({
                count: 0,
                rejected: true,
                notOwned:
                  e._tag === "AccessDeniedException"
                    ? (e.message ?? "").includes("not owned by you")
                    : true,
                // Surfaced so a failing assertion shows the real rejection.
                detail: `${e._tag}: ${e.message ?? ""}`.slice(0, 300),
              }),
            ),
          );
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "GET" && pathname === "/dns-test") {
          // The zone apex NS record answers even without delegation.
          const detail = yield* getHostedZone();
          const answer = yield* testDnsAnswer({
            RecordName: detail.HostedZone.Name,
            RecordType: "NS",
          });
          return yield* HttpServerResponse.json({
            responseCode: answer.ResponseCode,
            recordCount: (answer.RecordData ?? []).length,
          });
        }

        if (request.method === "POST" && pathname === "/record/roundtrip") {
          // UPSERT → GetChange-poll INSYNC → List (finds it) → DELETE.
          // Exercises the full dynamic-DNS loop end-to-end and leaves no
          // orphan record (UPSERT makes re-runs after a crash idempotent).
          const detail = yield* getHostedZone();
          const zoneName = detail.HostedZone.Name;
          const recordName = `${PROBE_LABEL}.${zoneName}`;
          const recordSet = {
            Name: recordName,
            Type: "TXT" as const,
            TTL: 60,
            ResourceRecords: [{ Value: PROBE_VALUE }],
          };

          const upserted = yield* changeRecordSets({
            ChangeBatch: {
              Comment: "alchemy Route53 bindings roundtrip",
              Changes: [{ Action: "UPSERT", ResourceRecordSet: recordSet }],
            },
          });
          const changeStatus = yield* waitForInsync(upserted.ChangeInfo.Id);

          const listed = yield* listRecordSets({
            StartRecordName: recordName,
            StartRecordType: "TXT",
            MaxItems: 1,
          });
          const found = (listed.ResourceRecordSets ?? []).some(
            (set) => set.Name === recordName && set.Type === "TXT",
          );

          // A concurrent/previous cleanup racing the DELETE surfaces the
          // typed InvalidChangeBatch ("not found") — the record is gone
          // either way.
          yield* changeRecordSets({
            ChangeBatch: {
              Changes: [{ Action: "DELETE", ResourceRecordSet: recordSet }],
            },
          }).pipe(Effect.catchTag("InvalidChangeBatch", () => Effect.void));

          return yield* HttpServerResponse.json({
            changeStatus,
            found,
            deleted: true,
          });
        }

        if (request.method === "GET" && pathname === "/health/status") {
          const response = yield* getHealthCheckStatus();
          return yield* HttpServerResponse.json({
            observations: response.HealthCheckObservations.length,
          });
        }

        if (request.method === "GET" && pathname === "/health/failure-reason") {
          const response = yield* getHealthCheckLastFailureReason();
          return yield* HttpServerResponse.json({
            observations: response.HealthCheckObservations.length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Route53.ChangeResourceRecordSetsHttp,
        Route53.ListResourceRecordSetsHttp,
        Route53.GetHostedZoneHttp,
        Route53.TestDNSAnswerHttp,
        Route53.GetChangeHttp,
        Route53.GetHealthCheckStatusHttp,
        Route53.GetHealthCheckLastFailureReasonHttp,
        Route53.ListHostedZonesHttp,
        Route53.ListHostedZonesByNameHttp,
        Route53.ListHostedZonesByVPCHttp,
      ),
    ),
  ),
);

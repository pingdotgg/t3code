import * as Lambda from "@/AWS/Lambda";
import * as OpenSearch from "@/AWS/OpenSearch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// A well-formed-but-nonexistent domain name — the probe routes drive the
// bindings against it so the fixture exercises the IAM grants and the typed
// error decode at zero cost (no domain is ever created; domains take 15-25
// minutes to provision and bill per instance-hour).
const NONEXISTENT_DOMAIN = "alchemy-nonexistent-os-probe";

export class OpenSearchBindingsTestFunction extends Lambda.Function<Lambda.Function>()(
  "OpenSearchBindingsTestFunction",
) {}

/**
 * Account-level binding fixture: no OpenSearch domain is ever created. List
 * routes prove each grant and response decode against real (possibly empty)
 * account/catalog data; probe routes drive domain-addressed operations
 * against a nonexistent domain and must surface the service's typed
 * `ResourceNotFoundException` — an IAM gap would surface AccessDeniedException
 * and fail the route with an opaque 500.
 */
export default OpenSearchBindingsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // Event source: subscribe the host to OpenSearch Service notifications
    // flowing through the account's default bus. The deploy proves the
    // EventBridge rule + invoke permission wiring.
    yield* OpenSearch.consumeDomainEvents(
      { kinds: ["cluster-status", "software-update"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `opensearch event: ${event["detail-type"]} -> ${event.resources.join(", ")}`,
          ),
        ),
    );

    const describeDomain = yield* OpenSearch.DescribeDomain();
    const describeDomains = yield* OpenSearch.DescribeDomains();
    const describeDomainConfig = yield* OpenSearch.DescribeDomainConfig();
    const describeDomainHealth = yield* OpenSearch.DescribeDomainHealth();
    const describeDomainNodes = yield* OpenSearch.DescribeDomainNodes();
    const describeDomainChangeProgress =
      yield* OpenSearch.DescribeDomainChangeProgress();
    const listDomainNames = yield* OpenSearch.ListDomainNames();
    const describeDomainAutoTunes = yield* OpenSearch.DescribeDomainAutoTunes();
    const listScheduledActions = yield* OpenSearch.ListScheduledActions();
    const startDomainMaintenance = yield* OpenSearch.StartDomainMaintenance();
    const getDomainMaintenanceStatus =
      yield* OpenSearch.GetDomainMaintenanceStatus();
    const listDomainMaintenances = yield* OpenSearch.ListDomainMaintenances();
    const startServiceSoftwareUpdate =
      yield* OpenSearch.StartServiceSoftwareUpdate();
    const cancelServiceSoftwareUpdate =
      yield* OpenSearch.CancelServiceSoftwareUpdate();
    const getUpgradeStatus = yield* OpenSearch.GetUpgradeStatus();
    const getUpgradeHistory = yield* OpenSearch.GetUpgradeHistory();
    const getCompatibleVersions = yield* OpenSearch.GetCompatibleVersions();
    const listVersions = yield* OpenSearch.ListVersions();
    const listInstanceTypeDetails = yield* OpenSearch.ListInstanceTypeDetails();

    const bound = {
      describeDomain,
      describeDomains,
      describeDomainConfig,
      describeDomainHealth,
      describeDomainNodes,
      describeDomainChangeProgress,
      listDomainNames,
      describeDomainAutoTunes,
      listScheduledActions,
      startDomainMaintenance,
      getDomainMaintenanceStatus,
      listDomainMaintenances,
      startServiceSoftwareUpdate,
      cancelServiceSoftwareUpdate,
      getUpgradeStatus,
      getUpgradeHistory,
      getCompatibleVersions,
      listVersions,
      listInstanceTypeDetails,
    };

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

        if (request.method === "GET" && pathname === "/domain") {
          // A nonexistent domain must surface the typed not-found tag.
          const tag = yield* describeDomain({
            DomainName: NONEXISTENT_DOMAIN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/domains-batch") {
          // The batch describe returns an empty status list (no not-found
          // error) for unknown names — proves the grant and the decode.
          const result = yield* describeDomains({
            DomainNames: [NONEXISTENT_DOMAIN],
          });
          return yield* HttpServerResponse.json({
            count: (result.DomainStatusList ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/domain-config") {
          const tag = yield* describeDomainConfig({
            DomainName: NONEXISTENT_DOMAIN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/domain-health") {
          // OpenSearch reports a missing domain on this operation as the
          // typed `BaseException` ("Domain not found: …"), not
          // ResourceNotFoundException — both are typed tags; catch both and
          // surface whichever fired.
          const tag = yield* describeDomainHealth({
            DomainName: NONEXISTENT_DOMAIN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "BaseException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/domain-nodes") {
          // Missing domain surfaces as the typed `BaseException` here (see
          // /domain-health).
          const tag = yield* describeDomainNodes({
            DomainName: NONEXISTENT_DOMAIN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "BaseException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/change-progress") {
          // A domain with no in-flight change (or no domain at all) surfaces
          // as the typed `BaseException` ("No progress information found").
          const tag = yield* describeDomainChangeProgress({
            DomainName: NONEXISTENT_DOMAIN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "BaseException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/domain-names") {
          // Listing the account's domains succeeds (possibly empty) —
          // proves the grant and the schema decode.
          const result = yield* listDomainNames();
          return yield* HttpServerResponse.json({
            count: (result.DomainNames ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/auto-tunes") {
          const tag = yield* describeDomainAutoTunes({
            DomainName: NONEXISTENT_DOMAIN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/scheduled-actions") {
          const tag = yield* listScheduledActions({
            DomainName: NONEXISTENT_DOMAIN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/start-maintenance-probe"
        ) {
          // Starting maintenance on a nonexistent domain must surface the
          // typed not-found tag — proves the write-side grant without ever
          // rebooting anything.
          const tag = yield* startDomainMaintenance({
            DomainName: NONEXISTENT_DOMAIN,
            Action: "REBOOT_NODE",
          }).pipe(
            Effect.map(() => "Started"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/maintenance-status-probe"
        ) {
          // Missing domain surfaces as the typed `BaseException` here (see
          // /domain-health).
          const tag = yield* getDomainMaintenanceStatus({
            DomainName: NONEXISTENT_DOMAIN,
            MaintenanceId: "nonexistent-maintenance-id",
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "BaseException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/maintenances") {
          // Missing domain surfaces as the typed `BaseException` here (see
          // /domain-health).
          const tag = yield* listDomainMaintenances({
            DomainName: NONEXISTENT_DOMAIN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "BaseException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/software-update-probe") {
          const tag = yield* startServiceSoftwareUpdate({
            DomainName: NONEXISTENT_DOMAIN,
          }).pipe(
            Effect.map(() => "Started"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/cancel-software-update-probe"
        ) {
          const tag = yield* cancelServiceSoftwareUpdate({
            DomainName: NONEXISTENT_DOMAIN,
          }).pipe(
            Effect.map(() => "Cancelled"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/upgrade-status") {
          const tag = yield* getUpgradeStatus({
            DomainName: NONEXISTENT_DOMAIN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/upgrade-history") {
          const tag = yield* getUpgradeHistory({
            DomainName: NONEXISTENT_DOMAIN,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/compatible-versions") {
          // Without a DomainName the call maps every supported version to
          // its upgrade targets — proves the grant and the decode.
          const result = yield* getCompatibleVersions();
          return yield* HttpServerResponse.json({
            count: (result.CompatibleVersions ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/versions") {
          // The engine-version catalog is never empty.
          const result = yield* listVersions();
          return yield* HttpServerResponse.json({
            count: (result.Versions ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/instance-types") {
          // The instance-type catalog for a current engine version is never
          // empty.
          const result = yield* listInstanceTypeDetails({
            EngineVersion: "OpenSearch_2.19",
          });
          return yield* HttpServerResponse.json({
            count: (result.InstanceTypeDetails ?? []).length,
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
        Lambda.EventSource,
        OpenSearch.DescribeDomainHttp,
        OpenSearch.DescribeDomainsHttp,
        OpenSearch.DescribeDomainConfigHttp,
        OpenSearch.DescribeDomainHealthHttp,
        OpenSearch.DescribeDomainNodesHttp,
        OpenSearch.DescribeDomainChangeProgressHttp,
        OpenSearch.ListDomainNamesHttp,
        OpenSearch.DescribeDomainAutoTunesHttp,
        OpenSearch.ListScheduledActionsHttp,
        OpenSearch.StartDomainMaintenanceHttp,
        OpenSearch.GetDomainMaintenanceStatusHttp,
        OpenSearch.ListDomainMaintenancesHttp,
        OpenSearch.StartServiceSoftwareUpdateHttp,
        OpenSearch.CancelServiceSoftwareUpdateHttp,
        OpenSearch.GetUpgradeStatusHttp,
        OpenSearch.GetUpgradeHistoryHttp,
        OpenSearch.GetCompatibleVersionsHttp,
        OpenSearch.ListVersionsHttp,
        OpenSearch.ListInstanceTypeDetailsHttp,
      ),
    ),
  ),
);

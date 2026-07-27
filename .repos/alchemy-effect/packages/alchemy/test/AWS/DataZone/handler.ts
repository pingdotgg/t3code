import * as DataZone from "@/AWS/DataZone";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Deterministic domain name so the test can find the domain id out-of-band
 * (needed to create a DataZone user profile for the function's role).
 */
export const BINDINGS_DOMAIN_NAME = "alchemy-datazone-bindings-test";

/**
 * Deterministic project name so the test can find the project id
 * out-of-band (needed to add the function's user profile as a member —
 * inventory search is project-scoped).
 */
export const BINDINGS_PROJECT_NAME = "alchemy-datazone-bindings-project";

export class DataZoneTestFunction extends Lambda.Function<Lambda.Function>()(
  "DataZoneTestFunction",
) {}

export default DataZoneTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The domain every domain-scoped binding is bound to.
    const domain = yield* DataZone.Domain("BindingsDomain", {
      name: BINDINGS_DOMAIN_NAME,
      description: "alchemy datazone bindings fixture domain",
    });

    // A project for the project-scoped calls (inventory search requires an
    // owning project; subscription listing requires a project filter).
    const project = yield* DataZone.Project("BindingsProject", {
      domainId: domain.domainId,
      name: BINDINGS_PROJECT_NAME,
      description: "alchemy datazone bindings fixture project",
    });
    const ProjectId = yield* project.projectId;

    // Event source: subscribe the host to DataZone workflow events. The
    // deploy proves the EventBridge rule + invoke permission wiring.
    yield* DataZone.consumeDataZoneEvents(
      { detailTypes: ["Subscription Request Created"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(`datazone event: ${event.detail.metadata?.id}`),
        ),
    );

    const bound = {
      search: yield* DataZone.Search(domain),
      searchListings: yield* DataZone.SearchListings(domain),
      searchTypes: yield* DataZone.SearchTypes(domain),
      getListing: yield* DataZone.GetListing(domain),
      getAsset: yield* DataZone.GetAsset(domain),
      createAsset: yield* DataZone.CreateAsset(domain),
      createAssetRevision: yield* DataZone.CreateAssetRevision(domain),
      acceptPredictions: yield* DataZone.AcceptPredictions(domain),
      rejectPredictions: yield* DataZone.RejectPredictions(domain),
      postLineageEvent: yield* DataZone.PostLineageEvent(domain),
      getLineageNode: yield* DataZone.GetLineageNode(domain),
      postTimeSeriesDataPoints:
        yield* DataZone.PostTimeSeriesDataPoints(domain),
      listTimeSeriesDataPoints:
        yield* DataZone.ListTimeSeriesDataPoints(domain),
      getTimeSeriesDataPoint: yield* DataZone.GetTimeSeriesDataPoint(domain),
      createSubscriptionRequest:
        yield* DataZone.CreateSubscriptionRequest(domain),
      acceptSubscriptionRequest:
        yield* DataZone.AcceptSubscriptionRequest(domain),
      rejectSubscriptionRequest:
        yield* DataZone.RejectSubscriptionRequest(domain),
      getSubscription: yield* DataZone.GetSubscription(domain),
      listSubscriptions: yield* DataZone.ListSubscriptions(domain),
      listSubscriptionRequests:
        yield* DataZone.ListSubscriptionRequests(domain),
      cancelSubscription: yield* DataZone.CancelSubscription(domain),
      revokeSubscription: yield* DataZone.RevokeSubscription(domain),
      startDataSourceRun: yield* DataZone.StartDataSourceRun(domain),
      getDataSourceRun: yield* DataZone.GetDataSourceRun(domain),
      listDataSourceRuns: yield* DataZone.ListDataSourceRuns(domain),
      startMetadataGenerationRun:
        yield* DataZone.StartMetadataGenerationRun(domain),
      getMetadataGenerationRun:
        yield* DataZone.GetMetadataGenerationRun(domain),
      getIamPortalLoginUrl: yield* DataZone.GetIamPortalLoginUrl(domain),
      listNotifications: yield* DataZone.ListNotifications(domain),
      getUserProfile: yield* DataZone.GetUserProfile(domain),
    };

    /**
     * Run a DataZone call and answer `{ ok: true, ... }` on success, or a
     * 502 carrying the typed error tag on failure — so the test's retry
     * loop surfaces the exact DataZone error instead of an opaque 500.
     */
    const respond = <A, E>(
      effect: Effect.Effect<A, E>,
      body: (value: A) => Record<string, unknown>,
    ) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(effect);
        return yield* Result.isSuccess(result)
          ? HttpServerResponse.json({ ok: true, ...body(result.success) })
          : HttpServerResponse.json(
              { ok: false, error: String(result.failure) },
              { status: 502 },
            );
      });

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

        // Inventory search: the domain id is injected from the binding;
        // inventory assets are project-scoped, so the owning project is
        // required.
        if (request.method === "GET" && pathname === "/search") {
          const owningProjectIdentifier = yield* ProjectId;
          return yield* respond(
            bound.search({ searchScope: "ASSET", owningProjectIdentifier }),
            (result) => ({
              totalMatchCount: result.totalMatchCount ?? 0,
              items: (result.items ?? []).length,
            }),
          );
        }

        // Listing search over the published catalog.
        if (request.method === "GET" && pathname === "/listings") {
          return yield* respond(bound.searchListings({}), (result) => ({
            items: (result.items ?? []).length,
          }));
        }

        // Approved subscriptions (empty in a fresh domain). DataZone
        // requires a project (or listing/principal) filter.
        if (request.method === "GET" && pathname === "/subscriptions") {
          const owningProjectId = yield* ProjectId;
          return yield* respond(
            bound.listSubscriptions({ status: "APPROVED", owningProjectId }),
            (result) => ({ items: (result.items ?? []).length }),
          );
        }

        // Pending subscription requests (empty in a fresh domain). Same
        // project filter requirement as /subscriptions.
        if (request.method === "GET" && pathname === "/requests") {
          const owningProjectId = yield* ProjectId;
          return yield* respond(
            bound.listSubscriptionRequests({
              status: "PENDING",
              owningProjectId,
            }),
            (result) => ({ items: (result.items ?? []).length }),
          );
        }

        // Single-use data portal sign-in URL.
        if (request.method === "GET" && pathname === "/portal") {
          return yield* respond(bound.getIamPortalLoginUrl(), (result) => ({
            authCodeUrl: result.authCodeUrl,
            userProfileId: result.userProfileId,
          }));
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
        DataZone.SearchHttp,
        DataZone.SearchListingsHttp,
        DataZone.SearchTypesHttp,
        DataZone.GetListingHttp,
        DataZone.GetAssetHttp,
        DataZone.CreateAssetHttp,
        DataZone.CreateAssetRevisionHttp,
        DataZone.AcceptPredictionsHttp,
        DataZone.RejectPredictionsHttp,
        DataZone.PostLineageEventHttp,
        DataZone.GetLineageNodeHttp,
        DataZone.PostTimeSeriesDataPointsHttp,
        DataZone.ListTimeSeriesDataPointsHttp,
        DataZone.GetTimeSeriesDataPointHttp,
        DataZone.CreateSubscriptionRequestHttp,
        DataZone.AcceptSubscriptionRequestHttp,
        DataZone.RejectSubscriptionRequestHttp,
        DataZone.GetSubscriptionHttp,
        DataZone.ListSubscriptionsHttp,
        DataZone.ListSubscriptionRequestsHttp,
        DataZone.CancelSubscriptionHttp,
        DataZone.RevokeSubscriptionHttp,
        DataZone.StartDataSourceRunHttp,
        DataZone.GetDataSourceRunHttp,
        DataZone.ListDataSourceRunsHttp,
        DataZone.StartMetadataGenerationRunHttp,
        DataZone.GetMetadataGenerationRunHttp,
        DataZone.GetIamPortalLoginUrlHttp,
        DataZone.ListNotificationsHttp,
        DataZone.GetUserProfileHttp,
      ),
    ),
  ),
);

import * as EMR from "@/AWS/EMR";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Deterministic release label the catalog routes pin to — old enough to be
 * available in every region the tests run in.
 */
export const PROBE_RELEASE_LABEL = "emr-7.5.0";

export class EmrTestFunction extends Lambda.Function<Lambda.Function>()(
  "EmrTestFunction",
) {}

/**
 * Account-scoped binding fixture: no EMR cluster is ever created. The four
 * discovery/catalog bindings and the EventBridge event source deploy and are
 * driven at zero cost.
 */
export default EmrTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Event source: subscribe the host to EMR cluster + step state changes.
    // The deploy proves the EventBridge rule + invoke permission wiring.
    yield* EMR.consumeClusterEvents({ kinds: ["cluster", "step"] }, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(
          `emr event: ${event.detail.clusterId} -> ${event.detail.state}`,
        ),
      ),
    );

    const listClusters = yield* EMR.ListClusters();
    const listReleaseLabels = yield* EMR.ListReleaseLabels();
    const describeReleaseLabel = yield* EMR.DescribeReleaseLabel();
    const listSupportedInstanceTypes = yield* EMR.ListSupportedInstanceTypes();

    const bound = {
      listClusters,
      listReleaseLabels,
      describeReleaseLabel,
      listSupportedInstanceTypes,
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

        // Account inventory (possibly empty) — proves the `*` grant and the
        // response schema decode.
        if (request.method === "GET" && pathname === "/clusters") {
          const { Clusters } = yield* listClusters({
            ClusterStates: ["STARTING", "RUNNING", "WAITING"],
          });
          return yield* HttpServerResponse.json({
            count: (Clusters ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/releases") {
          const { ReleaseLabels } = yield* listReleaseLabels();
          return yield* HttpServerResponse.json({
            count: (ReleaseLabels ?? []).length,
            latest: ReleaseLabels?.[0],
          });
        }

        if (request.method === "GET" && pathname === "/release") {
          const { Applications } = yield* describeReleaseLabel({
            ReleaseLabel: PROBE_RELEASE_LABEL,
          });
          return yield* HttpServerResponse.json({
            applications: (Applications ?? []).map((app) => app.Name),
          });
        }

        if (request.method === "GET" && pathname === "/instance-types") {
          const { SupportedInstanceTypes } = yield* listSupportedInstanceTypes({
            ReleaseLabel: PROBE_RELEASE_LABEL,
          });
          return yield* HttpServerResponse.json({
            types: (SupportedInstanceTypes ?? []).map((t) => t.Type),
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
        EMR.ListClustersHttp,
        EMR.ListReleaseLabelsHttp,
        EMR.DescribeReleaseLabelHttp,
        EMR.ListSupportedInstanceTypesHttp,
      ),
    ),
  ),
);

import * as AMP from "@/AWS/AMP";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class AmpTestFunction extends Lambda.Function<Lambda.Function>()(
  "AmpTestFunction",
) {}

export default AmpTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const workspace = yield* AMP.Workspace("BindingsWorkspace", {
      alias: "alchemy-test-amp-bindings",
      tags: { Environment: "test" },
    });

    const remoteWrite = yield* AMP.RemoteWrite(workspace);
    const metrics = yield* AMP.QueryMetrics(workspace);
    const labels = yield* AMP.GetLabels(workspace);
    const getSeries = yield* AMP.GetSeries(workspace);
    const getMetricMetadata = yield* AMP.GetMetricMetadata(workspace);
    const describeWorkspace = yield* AMP.DescribeWorkspace(workspace);
    const listWorkspaces = yield* AMP.ListWorkspaces();
    const getDefaultScraperConfiguration =
      yield* AMP.GetDefaultScraperConfiguration();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/health") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "POST" && pathname === "/remote-write") {
          const body = (yield* request.json) as unknown as {
            name: string;
            labels?: Record<string, string>;
            value: number;
            timestamp?: number;
          };
          yield* remoteWrite({
            timeseries: [
              {
                name: body.name,
                labels: body.labels,
                samples: [{ value: body.value, timestamp: body.timestamp }],
              },
            ],
          });
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "GET" && pathname === "/query") {
          const query = url.searchParams.get("query");
          if (!query) {
            return HttpServerResponse.text("Missing query", { status: 400 });
          }
          const result = yield* metrics.query({
            query,
            timeout: "30 seconds",
          });
          return yield* HttpServerResponse.json({ result });
        }

        if (request.method === "GET" && pathname === "/query-range") {
          const query = url.searchParams.get("query");
          if (!query) {
            return HttpServerResponse.text("Missing query", { status: 400 });
          }
          const now = yield* Effect.sync(() => Date.now());
          const result = yield* metrics.queryRange({
            query,
            start: new Date(now - 15 * 60_000),
            end: new Date(now),
            step: "30 seconds",
          });
          return yield* HttpServerResponse.json({ result });
        }

        if (request.method === "GET" && pathname === "/labels") {
          const names = yield* labels.labelNames();
          return yield* HttpServerResponse.json({ names });
        }

        if (request.method === "GET" && pathname === "/label-values") {
          const label = url.searchParams.get("label");
          if (!label) {
            return HttpServerResponse.text("Missing label", { status: 400 });
          }
          const values = yield* labels.labelValues({ label });
          return yield* HttpServerResponse.json({ values });
        }

        if (request.method === "GET" && pathname === "/series") {
          const match = url.searchParams.getAll("match");
          if (match.length === 0) {
            return HttpServerResponse.text("Missing match", { status: 400 });
          }
          const series = yield* getSeries({ match });
          return yield* HttpServerResponse.json({ series });
        }

        if (request.method === "GET" && pathname === "/describe-workspace") {
          const response = yield* describeWorkspace();
          return yield* HttpServerResponse.json({
            workspaceId: response.workspace.workspaceId,
            status: response.workspace.status.statusCode,
          });
        }

        if (request.method === "GET" && pathname === "/list-workspaces") {
          const response = yield* listWorkspaces();
          return yield* HttpServerResponse.json({
            workspaceIds: response.workspaces.map((w) => w.workspaceId),
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/default-scraper-config"
        ) {
          const configuration = yield* getDefaultScraperConfiguration();
          return yield* HttpServerResponse.json({ configuration });
        }

        if (request.method === "GET" && pathname === "/metadata") {
          const metadata = yield* getMetricMetadata({
            metric: url.searchParams.get("metric") ?? undefined,
          });
          return yield* HttpServerResponse.json({ metadata });
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
        AMP.RemoteWriteHttp,
        AMP.QueryMetricsHttp,
        AMP.GetLabelsHttp,
        AMP.GetSeriesHttp,
        AMP.GetMetricMetadataHttp,
        AMP.DescribeWorkspaceHttp,
        AMP.ListWorkspacesHttp,
        AMP.GetDefaultScraperConfigurationHttp,
      ),
    ),
  ),
);

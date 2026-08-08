import * as Lambda from "@/AWS/Lambda";
import * as ResourceExplorer from "@/AWS/ResourceExplorer";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class ResourceExplorerTestFunction extends Lambda.Function<Lambda.Function>()(
  "ResourceExplorerTestFunction",
) {}

export default ResourceExplorerTestFunction.make(
  {
    main,
    url: true,
    // search over a fresh index can be slow on cold start — AWS's 3s
    // default intermittently times out
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The index is the region singleton that makes search possible; the
    // view provider retries through its provisioning window.
    yield* ResourceExplorer.Index("Explorer", {});
    const view = yield* ResourceExplorer.View("SearchView", {
      includedProperties: ["tags"],
    });
    const search = yield* ResourceExplorer.Search(view);
    const listResources = yield* ResourceExplorer.ListResources(view);
    const listSupportedResourceTypes =
      yield* ResourceExplorer.ListSupportedResourceTypes();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/search") {
          const q = url.searchParams.get("q") ?? "service:s3";
          const result = yield* search({ QueryString: q, MaxResults: 25 });
          return yield* HttpServerResponse.json({
            viewArn: result.ViewArn,
            totalResources: result.Count?.TotalResources ?? 0,
            complete: result.Count?.Complete ?? false,
            resources: (result.Resources ?? []).map((r) => r.Arn),
          });
        }

        if (request.method === "GET" && pathname === "/resources") {
          const filter = url.searchParams.get("filter");
          const result = yield* listResources({
            Filters: filter !== null ? { FilterString: filter } : undefined,
            MaxResults: 25,
          });
          return yield* HttpServerResponse.json({
            viewArn: result.ViewArn,
            resources: (result.Resources ?? []).map((r) => r.Arn),
          });
        }

        if (request.method === "GET" && pathname === "/types") {
          const result = yield* listSupportedResourceTypes({
            MaxResults: 100,
          });
          return yield* HttpServerResponse.json({
            resourceTypes: (result.ResourceTypes ?? []).map(
              (t) => t.ResourceType,
            ),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ResourceExplorer.SearchHttp,
        ResourceExplorer.ListResourcesHttp,
        ResourceExplorer.ListSupportedResourceTypesHttp,
      ),
    ),
  ),
);

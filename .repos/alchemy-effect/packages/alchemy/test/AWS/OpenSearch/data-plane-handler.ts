import * as Lambda from "@/AWS/Lambda";
import * as OpenSearch from "@/AWS/OpenSearch";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "data-plane-handler.ts");

interface Song {
  title: string;
  plays: number;
}

export class OpenSearchDataPlaneFunction extends Lambda.Function<Lambda.Function>()(
  "OpenSearchDataPlaneFunction",
) {}

/**
 * Lambda fixture exercising the OpenSearch domain data-plane bindings
 * (`DomainRead` / `DomainWrite` / `DomainReadWrite`) against a real domain.
 * The domain has no resource-based access policy, so authorization is purely
 * the identity-based `es:ESHttp*` grants the bindings attach — a missing
 * grant surfaces as a 403 from the data plane.
 */
export default OpenSearchDataPlaneFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const domain = yield* OpenSearch.Domain("DataPlaneDomain", {
      clusterConfig: { instanceType: "t3.small.search", instanceCount: 1 },
      ebsOptions: { volumeType: "gp3", volumeSize: 10 },
    });

    const reader = yield* OpenSearch.DomainRead(domain);
    const writer = yield* OpenSearch.DomainWrite(domain);
    const client = yield* OpenSearch.DomainReadWrite(domain);

    const bound = { reader, writer, client };

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

        if (request.method === "POST" && pathname === "/doc") {
          // DomainWrite: PUT /{index}/_doc/{id} (es:ESHttpPut).
          const response = yield* writer.indexDocument(
            "songs",
            { title: "The Wind Cries Mary", plays: 1 } satisfies Song,
            { id: "1", refresh: true },
          );
          return yield* HttpServerResponse.json({ result: response.result });
        }

        if (request.method === "GET" && pathname === "/doc") {
          // DomainRead: GET /{index}/_doc/{id} (es:ESHttpGet).
          const doc = yield* reader.getDocument<Song>("songs", "1");
          return yield* HttpServerResponse.json({
            found: doc.found,
            title: doc._source?.title,
          });
        }

        if (request.method === "GET" && pathname === "/doc-missing") {
          // A missing document is found:false, not an error.
          const doc = yield* reader.getDocument<Song>("songs", "missing");
          return yield* HttpServerResponse.json({ found: doc.found });
        }

        if (request.method === "GET" && pathname === "/exists") {
          // DomainRead: HEAD /{index}/_doc/{id} (es:ESHttpHead).
          const exists = yield* reader.existsDocument("songs", "1");
          const missing = yield* reader.existsDocument("songs", "missing");
          return yield* HttpServerResponse.json({ exists, missing });
        }

        if (request.method === "GET" && pathname === "/search") {
          // DomainRead: Query DSL via the `source` param stays on ESHttpGet.
          const result = yield* reader.search<Song>({
            index: "songs",
            body: { query: { match: { title: "wind" } } },
          });
          return yield* HttpServerResponse.json({
            total: result.hits.total.value,
            firstTitle: result.hits.hits[0]?._source.title,
          });
        }

        if (request.method === "GET" && pathname === "/count") {
          const result = yield* reader.count({ index: "songs" });
          return yield* HttpServerResponse.json({ count: result.count });
        }

        if (request.method === "POST" && pathname === "/bulk") {
          // DomainWrite: POST /_bulk with NDJSON (es:ESHttpPost).
          const response = yield* writer.bulk(
            [
              { index: { _index: "songs", _id: "2" } },
              { title: "Purple Haze", plays: 5 } satisfies Song,
            ],
            { refresh: true },
          );
          return yield* HttpServerResponse.json({
            errors: response.errors,
            items: response.items.length,
          });
        }

        if (request.method === "POST" && pathname === "/update") {
          const response = yield* writer.updateDocument(
            "songs",
            "1",
            { doc: { plays: 2 } },
            { refresh: true },
          );
          return yield* HttpServerResponse.json({ result: response.result });
        }

        if (request.method === "POST" && pathname === "/delete") {
          // DomainWrite: DELETE (es:ESHttpDelete); deleting twice yields
          // result "not_found" rather than an error.
          const first = yield* writer.deleteDocument("songs", "2", {
            refresh: true,
          });
          const second = yield* writer.deleteDocument("songs", "2", {
            refresh: true,
          });
          return yield* HttpServerResponse.json({
            first: first.result,
            second: second.result,
          });
        }

        if (request.method === "GET" && pathname === "/health") {
          // DomainReadWrite raw escape hatch (es:ESHttp*).
          const health = (yield* client.request("GET", "_cluster/health")) as {
            status?: string;
          };
          return yield* HttpServerResponse.json({ status: health.status });
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
        OpenSearch.DomainReadHttp,
        OpenSearch.DomainWriteHttp,
        OpenSearch.DomainReadWriteHttp,
      ),
    ),
  ),
);

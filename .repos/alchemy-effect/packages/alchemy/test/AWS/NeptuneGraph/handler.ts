import * as Lambda from "@/AWS/Lambda";
import * as NeptuneGraph from "@/AWS/NeptuneGraph";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class NeptuneGraphTestFunction extends Lambda.Function<Lambda.Function>()(
  "NeptuneGraphTestFunction",
) {}

export class FixtureGraph extends Context.Service<
  FixtureGraph,
  {
    graph: NeptuneGraph.Graph;
  }
>()("FixtureGraph") {}

export const FixtureGraphLive = Layer.effect(
  FixtureGraph,
  Effect.gen(function* () {
    // 16 m-NCUs is the smallest provisioned size; zero replicas and public
    // connectivity keep the fixture as cheap and simple as possible (data
    // plane is still IAM-authenticated).
    const graph = yield* NeptuneGraph.Graph("FixtureGraph", {
      provisionedMemory: 16,
      publicConnectivity: true,
      replicaCount: 0,
      deletionProtection: false,
      tags: { fixture: "neptune-graph" },
    });
    return { graph };
  }),
);

/**
 * Lambda fixture hosting the Neptune Analytics runtime bindings.
 *
 * Routes:
 * - `GET /graph` — the graph id/endpoint the fixture is bound to.
 * - `POST /query` — runs the openCypher query in the JSON body
 *   (`{ query, parameters? }`) and returns the parsed result document
 *   (ExecuteQuery binding).
 * - `GET /summary` — the graph's data summary (GetGraphSummary binding).
 * - `GET /queries` — the graph's active queries (ListQueries binding).
 * - `GET /snapshots` — the graph's snapshots (ListGraphSnapshots binding).
 */
export const NeptuneGraphTestFunctionLive = NeptuneGraphTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { graph } = yield* FixtureGraph;
    const executeQuery = yield* NeptuneGraph.ExecuteQuery(graph);
    const getGraphSummary = yield* NeptuneGraph.GetGraphSummary(graph);
    const listQueries = yield* NeptuneGraph.ListQueries(graph);
    const listGraphSnapshots = yield* NeptuneGraph.ListGraphSnapshots(graph);
    const GraphId = yield* graph.graphId;
    const GraphEndpoint = yield* graph.endpoint;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/graph") {
          const graphId = yield* GraphId;
          const endpoint = yield* GraphEndpoint;
          return yield* HttpServerResponse.json({ graphId, endpoint });
        }

        if (request.method === "GET" && pathname === "/summary") {
          const summary = yield* getGraphSummary({ mode: "BASIC" });
          return yield* HttpServerResponse.json(summary);
        }

        if (request.method === "GET" && pathname === "/queries") {
          const queries = yield* listQueries({ maxResults: 100 });
          return yield* HttpServerResponse.json(queries);
        }

        if (request.method === "GET" && pathname === "/snapshots") {
          const snapshots = yield* listGraphSnapshots();
          return yield* HttpServerResponse.json(snapshots);
        }

        if (request.method === "POST" && pathname === "/query") {
          const body = (yield* request.json) as unknown as {
            query: string;
            parameters?: Record<string, unknown>;
          };
          const response = yield* executeQuery({
            queryString: body.query,
            language: "OPEN_CYPHER",
            parameters: body.parameters,
          });
          const payload = yield* response.payload.pipe(
            Stream.decodeText,
            Stream.mkString,
          );
          return yield* HttpServerResponse.json(JSON.parse(payload));
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
        NeptuneGraph.ExecuteQueryHttp,
        NeptuneGraph.GetGraphSummaryHttp,
        NeptuneGraph.ListQueriesHttp,
        NeptuneGraph.ListGraphSnapshotsHttp,
        FixtureGraphLive,
      ),
    ),
  ),
  // Re-merge so the deploying Stack can `yield* FixtureGraph` and expose the
  // graph attributes as deploy-time outputs. Reusing the same
  // `FixtureGraphLive` reference keeps it a single shared graph.
).pipe(Layer.provideMerge(FixtureGraphLive));

export default NeptuneGraphTestFunctionLive;

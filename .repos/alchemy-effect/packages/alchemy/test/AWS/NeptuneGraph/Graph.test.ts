import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import NeptuneGraphTestFunctionLive, {
  FixtureGraph,
  NeptuneGraphTestFunction,
} from "./handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete/wait paths depend on. Runs in
// every CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "getGraph on a nonexistent graph fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        // Well-formed but nonexistent graph id (g-<10 alphanumerics>).
        neptunegraph.getGraph({ graphIdentifier: "g-0123456789" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// The snapshot / import-task / export-task bindings address resources by
// server-generated ids that only exist at runtime — probe their typed
// not-found tags so the account-level grants and error unions stay proven
// without provisioning a graph.
test.provider(
  "getGraphSnapshot on a nonexistent snapshot fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        // Well-formed but nonexistent snapshot id (gs-<10 alphanumerics>).
        neptunegraph.getGraphSnapshot({ snapshotIdentifier: "gs-0123456789" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getImportTask on a nonexistent task fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        neptunegraph.getImportTask({ taskIdentifier: "t-0123456789" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getExportTask on a nonexistent task fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        neptunegraph.getExportTask({ taskIdentifier: "t-0123456789" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertGraphGone = (graphId: string) =>
  neptunegraph.getGraph({ graphIdentifier: graphId }).pipe(
    Effect.flatMap((graph) =>
      Effect.fail(
        new Error(`graph '${graphId}' still exists (status: ${graph.status})`),
      ),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(30),
      ]),
    }),
  );

// A Neptune Analytics graph takes ~5-10 minutes to provision and bills per
// m-NCU-hour (16 m-NCUs here) while it exists. The full lifecycle — graph +
// Lambda running openCypher through the ExecuteQuery binding — is gated
// behind AWS_TEST_SLOW=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create graph, query it from Lambda via ExecuteQuery, destroy",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const { graph, fn } = yield* stack.deploy(
        Effect.gen(function* () {
          const { graph } = yield* FixtureGraph;
          const fn = yield* NeptuneGraphTestFunction;
          return { graph, fn };
        }).pipe(Effect.provide(NeptuneGraphTestFunctionLive)),
      );

      expect(graph.graphId).toMatch(/^g-/);
      expect(graph.graphArn).toContain(":graph/");
      expect(graph.status).toBe("AVAILABLE");
      expect(graph.provisionedMemory).toBe(16);
      expect(graph.publicConnectivity).toBe(true);
      expect(graph.replicaCount).toBe(0);
      expect(graph.deletionProtection).toBe(false);
      expect(graph.endpoint).toContain("neptune-graph");

      // Out-of-band verification via distilled.
      const observed = yield* neptunegraph.getGraph({
        graphIdentifier: graph.graphId,
      });
      expect(observed.status).toBe("AVAILABLE");
      expect(observed.name).toBe(graph.graphName);

      // Drive the deployed Lambda. First request rides URL propagation —
      // bounded retry.
      const baseUrl = fn.functionUrl!.replace(/\/+$/, "");

      const graphInfo = yield* HttpClient.get(`${baseUrl}/graph`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.fail(new Error(`/graph returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("3 seconds"),
            Schedule.recurs(40),
          ]),
        }),
      );
      expect((graphInfo as { graphId: string }).graphId).toBe(graph.graphId);

      // openCypher through the ExecuteQuery binding: write a node, read it
      // back.
      const query = (body: {
        query: string;
        parameters?: Record<string, unknown>;
      }) =>
        HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/query`).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        ).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : res.text.pipe(
                  Effect.flatMap((text) =>
                    Effect.fail(
                      new Error(`/query returned ${res.status}: ${text}`),
                    ),
                  ),
                ),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(10),
            ]),
          }),
        );

      yield* query({
        query: "CREATE (n:Person {name: $name})",
        parameters: { name: "Ada" },
      });
      const read = (yield* query({
        query: "MATCH (n:Person) RETURN n.name AS name",
      })) as { results: Array<{ name: string }> };
      expect(read.results).toEqual([{ name: "Ada" }]);

      const getJson = (path: string) =>
        HttpClient.get(`${baseUrl}${path}`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : res.text.pipe(
                  Effect.flatMap((text) =>
                    Effect.fail(
                      new Error(`${path} returned ${res.status}: ${text}`),
                    ),
                  ),
                ),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(10),
            ]),
          }),
        );

      // GetGraphSummary binding: the summary document reflects the graph.
      const summary = (yield* getJson("/summary")) as {
        graphSummary?: { numNodes?: number };
      };
      expect(summary.graphSummary).toBeDefined();

      // ListQueries binding: returns a well-formed (usually empty) list.
      const queries = (yield* getJson("/queries")) as {
        queries: unknown[];
      };
      expect(Array.isArray(queries.queries)).toBe(true);

      // ListGraphSnapshots binding: fresh graph has no snapshots.
      const snapshots = (yield* getJson("/snapshots")) as {
        graphSnapshots: unknown[];
      };
      expect(Array.isArray(snapshots.graphSnapshots)).toBe(true);

      // Destroy immediately — the graph bills while it exists — and verify
      // it is fully gone out-of-band.
      yield* stack.destroy();
      yield* assertGraphGone(graph.graphId);
    }),
  // graph create (~5-10 min) + lambda deploy + delete-until-gone, one test.
  { timeout: 1_500_000 },
);

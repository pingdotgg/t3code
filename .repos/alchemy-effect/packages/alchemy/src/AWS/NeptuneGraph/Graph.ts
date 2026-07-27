import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface GraphProps {
  /**
   * Name of the graph (lowercase letters, numbers, and hyphens; must start
   * with a letter). If omitted, a deterministic name is generated.
   * Changing it forces replacement.
   */
  graphName?: string;
  /**
   * Provisioned memory-optimized Neptune Capacity Units (m-NCUs) for the
   * graph, e.g. `16`, `32`, `64`. In-place modify.
   */
  provisionedMemory: number;
  /**
   * Whether the graph endpoint is reachable from the public internet
   * (requests are still IAM-authenticated). In-place modify.
   * @default false
   */
  publicConnectivity?: boolean;
  /**
   * Number of replicas in other AZs. Replicas incur additional cost.
   * Immutable — forces replacement.
   * @default 1
   */
  replicaCount?: number;
  /**
   * KMS key used to encrypt data in the graph. Immutable — forces
   * replacement.
   */
  kmsKeyIdentifier?: string;
  /**
   * Vector-search configuration (dimension of vectors, 1-65535). Immutable —
   * forces replacement.
   */
  vectorSearchConfiguration?: {
    /**
     * Number of dimensions per vector.
     */
    dimension: number;
  };
  /**
   * Block accidental deletion. In-place modify.
   * @default true
   */
  deletionProtection?: boolean;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface Graph extends Resource<
  "AWS.NeptuneGraph.Graph",
  GraphProps,
  {
    /** Server-assigned unique id of the graph (e.g. `g-abc123`). */
    graphId: string;
    /** Name of the graph. */
    graphName: string;
    /** ARN of the graph. */
    graphArn: string;
    /** HTTPS query endpoint of the graph. */
    endpoint: string | undefined;
    /** Current lifecycle status (e.g. `CREATING`, `AVAILABLE`). */
    status: string | undefined;
    /** Provisioned memory in m-NCUs. */
    provisionedMemory: number | undefined;
    /** Whether the endpoint is reachable from the public internet. */
    publicConnectivity: boolean | undefined;
    /** Number of read replicas. */
    replicaCount: number | undefined;
    /** KMS key encrypting the graph, if customer-managed. */
    kmsKeyIdentifier: string | undefined;
    /** Vector search embedding dimension, if enabled. */
    vectorSearchDimension: number | undefined;
    /** Whether deletion protection is enabled. */
    deletionProtection: boolean | undefined;
    /** Creation time of the graph (ISO 8601). */
    createTime: string | undefined;
    /** Tags on the graph (user + internal Alchemy tags). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Neptune Analytics graph — a serverless, memory-optimized graph
 * that serves openCypher queries over an IAM-authenticated HTTPS endpoint.
 * Unlike classic Neptune, a graph with `publicConnectivity: true` needs no
 * VPC plumbing at all. Provisioning takes several minutes and the graph
 * bills per m-NCU-hour while it exists.
 *
 * Mutable fields (`provisionedMemory`, `publicConnectivity`,
 * `deletionProtection`) are reconciled in place; immutable fields
 * (`replicaCount`, `kmsKeyIdentifier`, `vectorSearchConfiguration`) force a
 * replacement.
 * @resource
 * @section Creating a Graph
 * @example Publicly reachable analytics graph
 * ```typescript
 * const graph = yield* Graph("Knowledge", {
 *   provisionedMemory: 16,
 *   publicConnectivity: true,
 *   replicaCount: 0,
 *   deletionProtection: false,
 * });
 * ```
 *
 * @section Vector Search
 * @example Graph with vector search enabled
 * ```typescript
 * const graph = yield* Graph("Embeddings", {
 *   provisionedMemory: 16,
 *   vectorSearchConfiguration: { dimension: 1536 },
 * });
 * ```
 *
 * @section Querying
 * @example Query from a Lambda function via the ExecuteQuery binding
 * ```typescript
 * const executeQuery = yield* AWS.NeptuneGraph.ExecuteQuery(graph);
 * const result = yield* executeQuery({
 *   queryString: "MATCH (n) RETURN count(n) AS n",
 *   language: "OPEN_CYPHER",
 * });
 * ```
 */
export const Graph = Resource<Graph>("AWS.NeptuneGraph.Graph");

type GraphOutput = neptunegraph.GetGraphOutput;

/**
 * The graph entered the terminal `FAILED` state during provisioning or a
 * modification. Not retried.
 */
export class GraphProvisioningFailed extends Data.TaggedError(
  "GraphProvisioningFailed",
)<{
  readonly graphId: string;
  readonly reason: string;
}> {}

class GraphNotReady extends Data.TaggedError("GraphNotReady")<{
  readonly graphId: string;
  readonly status: string;
}> {}

const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

const toAttrs = ({
  graph,
  tags,
}: {
  graph: GraphOutput;
  tags: Record<string, string>;
}): Graph["Attributes"] => ({
  graphId: graph.id,
  graphName: graph.name,
  graphArn: graph.arn,
  endpoint: graph.endpoint,
  status: graph.status,
  provisionedMemory: graph.provisionedMemory,
  publicConnectivity: graph.publicConnectivity,
  replicaCount: graph.replicaCount,
  kmsKeyIdentifier: graph.kmsKeyIdentifier,
  vectorSearchDimension: graph.vectorSearchConfiguration?.dimension,
  deletionProtection: graph.deletionProtection,
  createTime: graph.createTime?.toISOString(),
  tags,
});

export const GraphProvider = () =>
  Provider.effect(
    Graph,
    Effect.gen(function* () {
      const toName = (id: string, props: GraphProps) =>
        props.graphName
          ? Effect.succeed(props.graphName)
          : createPhysicalName({ id, maxLength: 63, lowercase: true });

      const getGraph = Effect.fn(function* (graphId: string) {
        return yield* neptunegraph
          .getGraph({ graphIdentifier: graphId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      // Graph names are unique per account/region — resolve a graph by name
      // when no id is cached (state-persistence failure recovery).
      const findGraphByName = Effect.fn(function* (name: string) {
        const summary = yield* neptunegraph.listGraphs.items({}).pipe(
          Stream.filter((graph) => graph.name === name),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );
        if (summary === undefined) return undefined;
        return yield* getGraph(summary.id);
      });

      const observeGraph = Effect.fn(function* (
        graphId: string | undefined,
        name: string,
      ) {
        if (graphId !== undefined) {
          const graph = yield* getGraph(graphId);
          if (graph !== undefined) return graph;
        }
        return yield* findGraphByName(name);
      });

      const readTags = Effect.fn(function* (arn: string) {
        const response = yield* neptunegraph
          .listTagsForResource({ resourceArn: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return toTagRecord(response?.tags);
      });

      // Explicitly-typed pipeable retry helper. Inlining `Effect.retry` in a
      // provider lifecycle op leaks `Retry.Return`'s conditional into
      // declaration emit and widens the provider layer to `unknown` R for
      // every consumer of `AWS.providers()`.
      const retryWhileGraphNotReady = <
        A,
        E extends { readonly _tag: string },
        R,
      >(
        self: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> =>
        Effect.retry(self, {
          while: (e) => e._tag === "GraphNotReady",
          schedule: Schedule.max([
            Schedule.fixed("10 seconds"),
            Schedule.recurs(90),
          ]),
        });

      // Bounded readiness wait: graph creation/modification takes several
      // minutes. Budgets ~15 min (90 * 10s). Fails fast on FAILED.
      const waitForGraph = Effect.fn(function* (graphId: string) {
        return yield* retryWhileGraphNotReady(
          Effect.gen(function* () {
            const graph = yield* getGraph(graphId);
            if (graph === undefined) {
              return yield* Effect.fail(
                new GraphNotReady({ graphId, status: "missing" }),
              );
            }
            if (graph.status === "FAILED") {
              return yield* Effect.fail(
                new GraphProvisioningFailed({
                  graphId,
                  reason: graph.statusReason ?? "unknown",
                }),
              );
            }
            if (graph.status !== "AVAILABLE") {
              return yield* Effect.fail(
                new GraphNotReady({
                  graphId,
                  status: graph.status ?? "unknown",
                }),
              );
            }
            return graph;
          }),
        );
      });

      return {
        stables: ["graphId", "graphArn", "graphName"],
        // AWS account/region collection: enumerate every Neptune Analytics
        // graph via the paginated `listGraphs`. Summaries omit create time,
        // vector-search config, and tags — emit undefined/empty for those
        // rather than a per-item `getGraph`/`listTagsForResource` fan-out.
        list: () =>
          neptunegraph.listGraphs.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).map((graph) => ({
                graphId: graph.id,
                graphName: graph.name,
                graphArn: graph.arn,
                endpoint: graph.endpoint,
                status: graph.status,
                provisionedMemory: graph.provisionedMemory,
                publicConnectivity: graph.publicConnectivity,
                replicaCount: graph.replicaCount,
                kmsKeyIdentifier: graph.kmsKeyIdentifier,
                vectorSearchDimension: undefined,
                deletionProtection: graph.deletionProtection,
                createTime: undefined,
                tags: {} as Record<string, string>,
              })),
            ),
          ),
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? { provisionedMemory: 0 })) !==
            (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          // Immutable props — any change forces a fresh graph.
          if (
            olds !== undefined &&
            (olds.replicaCount !== news.replicaCount ||
              olds.kmsKeyIdentifier !== news.kmsKeyIdentifier ||
              olds.vectorSearchConfiguration?.dimension !==
                news.vectorSearchConfiguration?.dimension)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.graphName ??
            (yield* toName(
              id,
              olds ?? ({ provisionedMemory: 0 } as GraphProps),
            ));
          const graph = yield* observeGraph(output?.graphId, name);
          if (graph === undefined) {
            return undefined;
          }
          const tags = yield* readTags(graph.arn);
          return toAttrs({ graph, tags });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.graphName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live graph state (by cached id, else by name).
          let observed = yield* observeGraph(output?.graphId, name);

          // Ensure — create if missing. A ConflictException here means a
          // peer reconciler won the create race — re-resolve by name.
          if (observed === undefined) {
            const created = yield* neptunegraph
              .createGraph({
                graphName: name,
                provisionedMemory: news.provisionedMemory,
                publicConnectivity: news.publicConnectivity,
                replicaCount: news.replicaCount,
                kmsKeyIdentifier: news.kmsKeyIdentifier,
                vectorSearchConfiguration: news.vectorSearchConfiguration,
                deletionProtection: news.deletionProtection,
                tags: desiredTags,
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            const graphId = created?.id ?? (yield* findGraphByName(name))?.id;
            if (graphId === undefined) {
              return yield* Effect.fail(
                new Error(`Failed to create graph '${name}'`),
              );
            }
            observed = yield* waitForGraph(graphId);
          } else {
            // Wait for the graph to settle before any modify so the call
            // doesn't hit ConflictException(CONCURRENT_MODIFICATION).
            observed = yield* waitForGraph(observed.id);

            // Sync — single `updateGraph` carrying only the in-place fields
            // whose desired value differs from the observed cloud state.
            const update: Omit<
              neptunegraph.UpdateGraphInput,
              "graphIdentifier"
            > = {};
            let dirty = false;
            if (
              news.provisionedMemory !== undefined &&
              news.provisionedMemory !== observed.provisionedMemory
            ) {
              update.provisionedMemory = news.provisionedMemory;
              dirty = true;
            }
            if (
              news.publicConnectivity !== undefined &&
              news.publicConnectivity !== observed.publicConnectivity
            ) {
              update.publicConnectivity = news.publicConnectivity;
              dirty = true;
            }
            if (
              news.deletionProtection !== undefined &&
              news.deletionProtection !== observed.deletionProtection
            ) {
              update.deletionProtection = news.deletionProtection;
              dirty = true;
            }
            if (dirty) {
              yield* neptunegraph.updateGraph({
                graphIdentifier: observed.id,
                ...update,
              });
              observed = yield* waitForGraph(observed.id);
            }
          }

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = yield* readTags(observed.arn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* neptunegraph.tagResource({
              resourceArn: observed.arn,
              tags: Object.fromEntries(
                upsert.map(({ Key, Value }) => [Key, Value]),
              ),
            });
          }
          if (removed.length > 0) {
            yield* neptunegraph.untagResource({
              resourceArn: observed.arn,
              tagKeys: removed,
            });
          }

          yield* session.note(observed.arn);
          return toAttrs({ graph: observed, tags: desiredTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          // Deletion is blocked while delete-protection is on — disable it
          // first if the live graph still has it enabled.
          const observed = yield* getGraph(output.graphId);
          if (observed === undefined) return;
          if (observed.deletionProtection === true) {
            yield* neptunegraph
              .updateGraph({
                graphIdentifier: output.graphId,
                deletionProtection: false,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
          }
          yield* neptunegraph
            .deleteGraph({
              graphIdentifier: output.graphId,
              skipSnapshot: true,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          // Block until the graph is fully gone — deletion is async and the
          // graph bills until it disappears.
          yield* Effect.repeat(
            neptunegraph.getGraph({ graphIdentifier: output.graphId }).pipe(
              Effect.as(true),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(false),
              ),
            ),
            {
              schedule: Schedule.max([
                Schedule.fixed("10 seconds"),
                Schedule.recurs(60),
              ]),
              until: (exists) => exists === false,
            },
          ).pipe(Effect.catch(() => Effect.void));
        }),
      };
    }),
  );

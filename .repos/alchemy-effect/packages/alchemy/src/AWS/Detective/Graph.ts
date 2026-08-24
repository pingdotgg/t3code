import * as detective from "@distilled.cloud/aws/detective";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface GraphProps {
  /**
   * Tags applied to the behavior graph. Alchemy ownership tags are merged in
   * automatically so the graph can be recognized on subsequent runs.
   */
  tags?: Record<string, string>;
}

/** @resource */
export interface Graph extends Resource<
  "AWS.Detective.Graph",
  GraphProps,
  {
    /** ARN of the Detective behavior graph. */
    graphArn: string;
    /** ISO timestamp of when the graph was created. */
    createdTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Detective behavior graph — the account/region singleton that enables Amazon
 * Detective. An account can have at most one behavior graph per region, so this
 * resource is a capture-and-restore singleton: adopting a pre-existing graph
 * that Alchemy did not create requires `--adopt`.
 *
 * @section Enabling Detective
 * @example Enable a behavior graph
 * ```typescript
 * const graph = yield* Detective.Graph("Graph", {});
 * ```
 *
 * @example Enable with tags
 * ```typescript
 * const graph = yield* Detective.Graph("Graph", {
 *   tags: { team: "security" },
 * });
 * ```
 */
const GraphResource = Resource<Graph>("AWS.Detective.Graph");

export { GraphResource as Graph };

const buildAttrs = (g: detective.Graph) => ({
  graphArn: g.Arn!,
  createdTime: g.CreatedTime?.toISOString(),
});

export const GraphProvider = () =>
  Provider.effect(
    GraphResource,
    Effect.gen(function* () {
      // Detective allows at most one behavior graph per account/region. Return
      // the first (only) graph, if any.
      const firstGraph = detective
        .listGraphs({})
        .pipe(Effect.map((r) => r.GraphList?.[0]));

      const readTags = (arn: string) =>
        detective.listTagsForResource({ ResourceArn: arn }).pipe(
          Effect.map((r) => (r.Tags ?? {}) as Record<string, string>),
          Effect.catch(() => Effect.succeed({} as Record<string, string>)),
        );

      return {
        read: Effect.fn(function* ({ id, output }) {
          const graph = yield* firstGraph;
          if (!graph?.Arn) return undefined;
          // If we have a cached ARN and it no longer matches the single graph,
          // the graph we knew about is gone.
          if (output?.graphArn && output.graphArn !== graph.Arn) {
            return undefined;
          }
          const attrs = buildAttrs(graph);
          const tags = yield* readTags(graph.Arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // Account/region singleton — enumerate the single behavior graph.
        list: () =>
          detective
            .listGraphs({})
            .pipe(Effect.map((r) => (r.GraphList ?? []).map(buildAttrs))),

        reconcile: Effect.fn(function* ({ id, news = {}, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          let graph = yield* firstGraph;

          // 2. ENSURE — create the graph (with tags inline) if none exists.
          if (!graph?.Arn) {
            const created = yield* detective.createGraph({
              Tags: desiredTags,
            });
            graph = { Arn: created.GraphArn! };
          }

          const arn = graph.Arn!;

          // 3. SYNC tags — diff against OBSERVED cloud tags.
          const currentTags = yield* readTags(arn);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* detective.tagResource({
              ResourceArn: arn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* detective.untagResource({
              ResourceArn: arn,
              TagKeys: removed,
            });
          }

          // 4. RETURN fresh attributes.
          const final = yield* firstGraph;
          yield* session.note(arn);
          return final?.Arn
            ? buildAttrs(final)
            : { graphArn: arn, createdTime: undefined };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* detective
            .deleteGraph({ GraphArn: output.graphArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

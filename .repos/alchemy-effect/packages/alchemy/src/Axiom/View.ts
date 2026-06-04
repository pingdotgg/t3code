import * as Axiom from "@distilled.cloud/axiom";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export type ViewProps = Axiom.CreateViewInput;

export type View = Resource<
  "Axiom.View",
  ViewProps,
  Axiom.CreateViewOutput & {
    /**
     * Path identifier used by `updateView` / `getView` / `deleteView`.
     * Currently derived from `name` because Axiom's view list/get responses
     * don't expose a separate id field.
     */
    id: string;
  },
  never,
  Providers
>;

/**
 * An Axiom saved view — a named, shareable APL query. Useful for building
 * starter dashboards, providing canned "open in Axiom" links from your app,
 * or pinning common investigations the team revisits.
 *
 * The path identifier is `name`. Renaming a view triggers a replacement
 * (the old one is deleted, a new one is created).
 *
 * @see https://axiom.co/docs/query-data/datasets — APL query reference
 *
 * @section Creating a View
 * @example Recent errors across one dataset
 * ```typescript
 * yield* Axiom.View("recent-errors", {
 *   name: "recent-errors",
 *   description: "Last 100 5xx responses",
 *   datasets: ["my-app-traces"],
 *   aplQuery: `
 *     ['my-app-traces']
 *     | where status >= 500
 *     | order by _time desc
 *     | take 100
 *   `,
 * });
 * ```
 *
 * @example Cross-dataset join (logs + traces by trace_id)
 * ```typescript
 * yield* Axiom.View("trace-with-logs", {
 *   name: "trace-with-logs",
 *   datasets: ["my-app-traces", "my-app-logs"],
 *   aplQuery: `
 *     ['my-app-traces']
 *     | where duration_ms > 1000
 *     | join kind=leftouter (['my-app-logs']) on trace_id
 *   `,
 * });
 * ```
 */
export const View = Resource<View>("Axiom.View");

export const ViewProvider = () =>
  Provider.effect(
    View,
    Effect.gen(function* () {
      const create = yield* Axiom.createView;
      const update = yield* Axiom.updateView;
      const get = yield* Axiom.getView;
      const del = yield* Axiom.deleteView;

      return {
        stables: ["id"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (output && news.name !== output.name) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe — `name` is the path identifier for views. Renames are
          // forced to a replacement by `diff` above, so the cached
          // `output.id` (set to `news.name` on first create) and the
          // current `news.name` always agree by the time we land here.
          const viewId = output?.id ?? news.name;
          const observed = yield* get({ id: viewId }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );

          // Ensure — POST creates the view under `news.name`.
          if (observed === undefined) {
            const result = yield* create(news);
            return { ...result, id: news.name };
          }

          // Sync — the view exists; PUT against its id with the desired
          // props.
          const result = yield* update({ ...news, id: viewId });
          return { ...result, id: viewId };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* get({ id: output.id }).pipe(
            Effect.map((current) => ({ ...current, id: output.id })),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
